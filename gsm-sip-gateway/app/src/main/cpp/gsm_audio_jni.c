/*
 * GSM Audio JNI - Native tinyalsa integration for GSM-SIP Gateway
 *
 * Replaces tinycap/tinyplay processes with direct ALSA access.
 * All parameters are configurable - no hardcoded device paths.
 */

#include <jni.h>
#include <android/log.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <pthread.h>
#include <errno.h>
#include <unistd.h>

#include "tinyalsa/include/tinyalsa/asoundlib.h"

#define TAG "GsmAudioNative"
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define AUDIO_QUEUE_CAPACITY 3

/* Audio context - holds all state */
struct gsm_audio_ctx {
    struct pcm *capture_pcm;
    struct pcm *playback_pcm;
    struct mixer *mixer;

    unsigned int card;
    unsigned int capture_device;
    unsigned int playback_device;
    unsigned int sample_rate;
    unsigned int channels;
    unsigned int bits;
    unsigned int period_size;
    unsigned int period_count;
    unsigned int frame_bytes;

    unsigned char *capture_queue;
    unsigned char *playback_queue;
    unsigned char *silence_frame;
    unsigned int capture_read;
    unsigned int capture_write;
    unsigned int capture_count;
    unsigned int playback_read;
    unsigned int playback_write;
    unsigned int playback_count;

    pthread_t capture_thread;
    pthread_t playback_thread;
    int capture_thread_started;
    int playback_thread_started;
    int running;
    unsigned long capture_underruns;
    unsigned long capture_drops;
    unsigned long playback_drops;

    int is_open;
    pthread_mutex_t lock;
    pthread_cond_t playback_ready;
};

static struct gsm_audio_ctx *g_ctx = NULL;

static unsigned char *queue_frame(unsigned char *queue, unsigned int index,
                                  unsigned int frame_bytes) {
    return queue + index * frame_bytes;
}

static void *capture_worker(void *opaque) {
    struct gsm_audio_ctx *ctx = (struct gsm_audio_ctx *)opaque;
    unsigned char *frame = (unsigned char *)malloc(ctx->frame_bytes);
    if (!frame) {
        LOGE("Capture worker allocation failed");
        return NULL;
    }

    while (1) {
        pthread_mutex_lock(&ctx->lock);
        int running = ctx->running;
        struct pcm *pcm = ctx->capture_pcm;
        pthread_mutex_unlock(&ctx->lock);
        if (!running || !pcm) break;

        if (pcm_read(pcm, frame, ctx->frame_bytes) != 0) {
            pthread_mutex_lock(&ctx->lock);
            running = ctx->running;
            pthread_mutex_unlock(&ctx->lock);
            if (running) LOGE("capture pcm_read failed: %s", pcm_get_error(pcm));
            usleep(10000);
            continue;
        }

        pthread_mutex_lock(&ctx->lock);
        if (ctx->running) {
            if (ctx->capture_count == AUDIO_QUEUE_CAPACITY) {
                ctx->capture_read = (ctx->capture_read + 1) % AUDIO_QUEUE_CAPACITY;
                ctx->capture_count--;
                ctx->capture_drops++;
            }
            memcpy(queue_frame(ctx->capture_queue, ctx->capture_write,
                               ctx->frame_bytes), frame, ctx->frame_bytes);
            ctx->capture_write = (ctx->capture_write + 1) % AUDIO_QUEUE_CAPACITY;
            ctx->capture_count++;
        }
        pthread_mutex_unlock(&ctx->lock);
    }

    free(frame);
    return NULL;
}

static void *playback_worker(void *opaque) {
    struct gsm_audio_ctx *ctx = (struct gsm_audio_ctx *)opaque;
    unsigned char *frame = (unsigned char *)malloc(ctx->frame_bytes);
    if (!frame) {
        LOGE("Playback worker allocation failed");
        return NULL;
    }

    while (1) {
        pthread_mutex_lock(&ctx->lock);
        while (ctx->running && ctx->playback_count == 0) {
            pthread_cond_wait(&ctx->playback_ready, &ctx->lock);
        }
        if (!ctx->running) {
            pthread_mutex_unlock(&ctx->lock);
            break;
        }

        memcpy(frame, queue_frame(ctx->playback_queue, ctx->playback_read,
                                  ctx->frame_bytes), ctx->frame_bytes);
        ctx->playback_read = (ctx->playback_read + 1) % AUDIO_QUEUE_CAPACITY;
        ctx->playback_count--;
        struct pcm *pcm = ctx->playback_pcm;
        pthread_mutex_unlock(&ctx->lock);

        if (pcm_write(pcm, frame, ctx->frame_bytes) != 0) {
            pthread_mutex_lock(&ctx->lock);
            int running = ctx->running;
            pthread_mutex_unlock(&ctx->lock);
            if (running) LOGE("playback pcm_write failed: %s", pcm_get_error(pcm));
        }
    }

    free(frame);
    return NULL;
}

static void release_audio_resources(struct gsm_audio_ctx *ctx) {
    if (ctx->mixer) mixer_close(ctx->mixer);
    if (ctx->playback_pcm) pcm_close(ctx->playback_pcm);
    if (ctx->capture_pcm) pcm_close(ctx->capture_pcm);
    ctx->mixer = NULL;
    ctx->playback_pcm = NULL;
    ctx->capture_pcm = NULL;

    free(ctx->capture_queue);
    free(ctx->playback_queue);
    free(ctx->silence_frame);
    ctx->capture_queue = NULL;
    ctx->playback_queue = NULL;
    ctx->silence_frame = NULL;
}

/* Helper: Get PCM format from bits */
static enum pcm_format bits_to_format(unsigned int bits) {
    switch (bits) {
        case 32: return PCM_FORMAT_S32_LE;
        case 24: return PCM_FORMAT_S24_LE;
        case 16:
        default: return PCM_FORMAT_S16_LE;
    }
}

/*
 * Open audio devices
 *
 * @param card          Sound card number (usually 0)
 * @param captureDevice PCM device for capture (VOC_REC)
 * @param playbackDevice PCM device for playback (Incall_Music)
 * @param sampleRate    Sample rate in Hz (16000 for AMR-WB)
 * @param channels      Number of channels (1 for mono)
 * @param bits          Bits per sample (16)
 * @param periodSize    Period size in frames (320 for 20ms @ 16kHz)
 * @param periodCount   Number of periods (4)
 */
JNIEXPORT jboolean JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_open(
        JNIEnv *env, jclass clazz,
        jint card, jint captureDevice, jint playbackDevice,
        jint sampleRate, jint channels, jint bits,
        jint periodSize, jint periodCount) {

    LOGI("Opening audio: card=%d, capture=%d, playback=%d, rate=%d, ch=%d, bits=%d, period=%d/%d",
         card, captureDevice, playbackDevice, sampleRate, channels, bits, periodSize, periodCount);

    if (g_ctx != NULL && g_ctx->is_open) {
        LOGE("Already open, close first");
        return JNI_FALSE;
    }

    /* Allocate context */
    if (g_ctx == NULL) {
        g_ctx = (struct gsm_audio_ctx *)calloc(1, sizeof(struct gsm_audio_ctx));
        if (!g_ctx) {
            LOGE("Failed to allocate context");
            return JNI_FALSE;
        }
        pthread_mutex_init(&g_ctx->lock, NULL);
        pthread_cond_init(&g_ctx->playback_ready, NULL);
    }

    g_ctx->card = card;
    g_ctx->capture_device = captureDevice;
    g_ctx->playback_device = playbackDevice;
    g_ctx->sample_rate = sampleRate;
    g_ctx->channels = channels;
    g_ctx->bits = bits;
    g_ctx->period_size = periodSize;
    g_ctx->period_count = periodCount;
    g_ctx->frame_bytes = periodSize * channels * (bits / 8);

    /* PCM config */
    struct pcm_config config;
    memset(&config, 0, sizeof(config));
    config.channels = channels;
    config.rate = sampleRate;
    config.period_size = periodSize;
    config.period_count = periodCount;
    config.format = bits_to_format(bits);
    config.start_threshold = 0;
    config.stop_threshold = 0;
    config.silence_threshold = 0;

    /* Open capture device */
    g_ctx->capture_pcm = pcm_open(card, captureDevice, PCM_IN, &config);
    if (!g_ctx->capture_pcm || !pcm_is_ready(g_ctx->capture_pcm)) {
        LOGE("Failed to open capture PCM %d:%d - %s",
             card, captureDevice,
             g_ctx->capture_pcm ? pcm_get_error(g_ctx->capture_pcm) : "null");
        if (g_ctx->capture_pcm) {
            pcm_close(g_ctx->capture_pcm);
            g_ctx->capture_pcm = NULL;
        }
        return JNI_FALSE;
    }
    LOGI("Capture PCM opened: %d:%d", card, captureDevice);

    /* Open playback device */
    g_ctx->playback_pcm = pcm_open(card, playbackDevice, PCM_OUT, &config);
    if (!g_ctx->playback_pcm || !pcm_is_ready(g_ctx->playback_pcm)) {
        LOGE("Failed to open playback PCM %d:%d - %s",
             card, playbackDevice,
             g_ctx->playback_pcm ? pcm_get_error(g_ctx->playback_pcm) : "null");
        if (g_ctx->playback_pcm) {
            pcm_close(g_ctx->playback_pcm);
            g_ctx->playback_pcm = NULL;
        }
        pcm_close(g_ctx->capture_pcm);
        g_ctx->capture_pcm = NULL;
        return JNI_FALSE;
    }
    LOGI("Playback PCM opened: %d:%d", card, playbackDevice);

    /* Open mixer */
    g_ctx->mixer = mixer_open(card);
    if (!g_ctx->mixer) {
        LOGE("Warning: Failed to open mixer for card %d", card);
        /* Continue anyway - mixer might not be needed */
    } else {
        LOGI("Mixer opened for card %d", card);
    }

    size_t queue_bytes = g_ctx->frame_bytes * AUDIO_QUEUE_CAPACITY;
    g_ctx->capture_queue = (unsigned char *)calloc(1, queue_bytes);
    g_ctx->playback_queue = (unsigned char *)calloc(1, queue_bytes);
    g_ctx->silence_frame = (unsigned char *)calloc(1, g_ctx->frame_bytes);
    if (!g_ctx->capture_queue || !g_ctx->playback_queue || !g_ctx->silence_frame) {
        LOGE("Failed to allocate audio queues");
        free(g_ctx->capture_queue);
        free(g_ctx->playback_queue);
        free(g_ctx->silence_frame);
        g_ctx->capture_queue = NULL;
        g_ctx->playback_queue = NULL;
        g_ctx->silence_frame = NULL;
        if (g_ctx->mixer) mixer_close(g_ctx->mixer);
        pcm_close(g_ctx->playback_pcm);
        pcm_close(g_ctx->capture_pcm);
        g_ctx->mixer = NULL;
        g_ctx->playback_pcm = NULL;
        g_ctx->capture_pcm = NULL;
        return JNI_FALSE;
    }

    g_ctx->capture_read = g_ctx->capture_write = g_ctx->capture_count = 0;
    g_ctx->playback_read = g_ctx->playback_write = g_ctx->playback_count = 0;
    g_ctx->capture_underruns = g_ctx->capture_drops = g_ctx->playback_drops = 0;
    g_ctx->capture_thread_started = 0;
    g_ctx->playback_thread_started = 0;
    g_ctx->running = 1;

    g_ctx->is_open = 1;
    if (pthread_create(&g_ctx->capture_thread, NULL, capture_worker, g_ctx) != 0) {
        LOGE("Failed to create capture worker");
        g_ctx->running = 0;
        g_ctx->is_open = 0;
        release_audio_resources(g_ctx);
        return JNI_FALSE;
    }
    g_ctx->capture_thread_started = 1;
    if (pthread_create(&g_ctx->playback_thread, NULL, playback_worker, g_ctx) != 0) {
        LOGE("Failed to create playback worker");
        pthread_mutex_lock(&g_ctx->lock);
        g_ctx->running = 0;
        pthread_mutex_unlock(&g_ctx->lock);
        pthread_join(g_ctx->capture_thread, NULL);
        g_ctx->capture_thread_started = 0;
        g_ctx->is_open = 0;
        release_audio_resources(g_ctx);
        return JNI_FALSE;
    }
    g_ctx->playback_thread_started = 1;
    LOGI("Audio workers started: frame=%u bytes, queue=%d frames",
         g_ctx->frame_bytes, AUDIO_QUEUE_CAPACITY);
    return JNI_TRUE;
}

/*
 * Close audio devices
 */
JNIEXPORT void JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_close(JNIEnv *env, jclass clazz) {
    LOGI("Closing audio");

    if (g_ctx == NULL) return;

    pthread_mutex_lock(&g_ctx->lock);
    g_ctx->is_open = 0;
    g_ctx->running = 0;
    pthread_cond_broadcast(&g_ctx->playback_ready);
    pthread_mutex_unlock(&g_ctx->lock);

    if (g_ctx->capture_thread_started) {
        pthread_join(g_ctx->capture_thread, NULL);
        g_ctx->capture_thread_started = 0;
    }
    if (g_ctx->playback_thread_started) {
        pthread_join(g_ctx->playback_thread, NULL);
        g_ctx->playback_thread_started = 0;
    }

    pthread_mutex_lock(&g_ctx->lock);

    release_audio_resources(g_ctx);

    LOGI("Audio queue stats: captureUnderruns=%lu, captureDrops=%lu, playbackDrops=%lu",
         g_ctx->capture_underruns, g_ctx->capture_drops, g_ctx->playback_drops);

    pthread_mutex_unlock(&g_ctx->lock);
    LOGI("Audio closed");
}

/*
 * Read audio frame from capture device (GSM -> SIP direction)
 *
 * @param buffer Byte array to fill with PCM data
 * @return Number of bytes read, or -1 on error
 */
JNIEXPORT jint JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_readFrame(
        JNIEnv *env, jclass clazz, jbyteArray buffer) {

    if (g_ctx == NULL || !g_ctx->is_open || !g_ctx->capture_pcm) {
        return -1;
    }

    jsize len = (*env)->GetArrayLength(env, buffer);
    if ((unsigned int)len != g_ctx->frame_bytes) {
        LOGE("Capture frame size mismatch: java=%d native=%u", len, g_ctx->frame_bytes);
        return -1;
    }

    pthread_mutex_lock(&g_ctx->lock);
    if (!g_ctx->is_open) {
        pthread_mutex_unlock(&g_ctx->lock);
        return -1;
    }
    const unsigned char *source;
    if (g_ctx->capture_count > 0) {
        source = queue_frame(g_ctx->capture_queue, g_ctx->capture_read,
                             g_ctx->frame_bytes);
        g_ctx->capture_read = (g_ctx->capture_read + 1) % AUDIO_QUEUE_CAPACITY;
        g_ctx->capture_count--;
    } else {
        source = g_ctx->silence_frame;
        g_ctx->capture_underruns++;
    }
    (*env)->SetByteArrayRegion(env, buffer, 0, len, (const jbyte *)source);
    pthread_mutex_unlock(&g_ctx->lock);
    if ((*env)->ExceptionCheck(env)) return -1;

    return len;
}

/*
 * Write audio frame to playback device (SIP -> GSM direction)
 *
 * @param buffer Byte array with PCM data
 * @return Number of bytes written, or -1 on error
 */
JNIEXPORT jint JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_writeFrame(
        JNIEnv *env, jclass clazz, jbyteArray buffer) {

    if (g_ctx == NULL || !g_ctx->is_open || !g_ctx->playback_pcm) {
        return -1;
    }

    jsize len = (*env)->GetArrayLength(env, buffer);
    if ((unsigned int)len != g_ctx->frame_bytes) {
        LOGE("Playback frame size mismatch: java=%d native=%u", len, g_ctx->frame_bytes);
        return -1;
    }

    pthread_mutex_lock(&g_ctx->lock);
    if (!g_ctx->is_open) {
        pthread_mutex_unlock(&g_ctx->lock);
        return -1;
    }
    if (g_ctx->playback_count == AUDIO_QUEUE_CAPACITY) {
        g_ctx->playback_read = (g_ctx->playback_read + 1) % AUDIO_QUEUE_CAPACITY;
        g_ctx->playback_count--;
        g_ctx->playback_drops++;
    }
    unsigned char *destination = queue_frame(
            g_ctx->playback_queue, g_ctx->playback_write, g_ctx->frame_bytes);
    (*env)->GetByteArrayRegion(env, buffer, 0, len, (jbyte *)destination);
    if ((*env)->ExceptionCheck(env)) {
        pthread_mutex_unlock(&g_ctx->lock);
        return -1;
    }
    g_ctx->playback_write = (g_ctx->playback_write + 1) % AUDIO_QUEUE_CAPACITY;
    g_ctx->playback_count++;
    pthread_cond_signal(&g_ctx->playback_ready);
    pthread_mutex_unlock(&g_ctx->lock);

    return len;
}

/*
 * Set mixer control value
 *
 * @param card        Sound card number
 * @param controlName Mixer control name (e.g. "MultiMedia1 Mixer VOC_REC_DL")
 * @param value       Value to set (0 or 1 for switches)
 * @return true on success
 */
JNIEXPORT jboolean JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_setMixerControl(
        JNIEnv *env, jclass clazz,
        jint card, jstring controlName, jint value) {

    const char *name = (*env)->GetStringUTFChars(env, controlName, NULL);
    if (!name) {
        LOGE("Failed to get control name string");
        return JNI_FALSE;
    }

    LOGD("setMixerControl: card=%d, control='%s', value=%d", card, name, value);

    struct mixer *mix = mixer_open(card);
    if (!mix) {
        LOGE("Failed to open mixer for card %d", card);
        (*env)->ReleaseStringUTFChars(env, controlName, name);
        return JNI_FALSE;
    }

    struct mixer_ctl *ctl = mixer_get_ctl_by_name(mix, name);
    if (!ctl) {
        LOGE("Mixer control '%s' not found", name);
        mixer_close(mix);
        (*env)->ReleaseStringUTFChars(env, controlName, name);
        return JNI_FALSE;
    }

    int ret = mixer_ctl_set_value(ctl, 0, value);
    if (ret < 0) {
        LOGE("Failed to set mixer control '%s' to %d: %d", name, value, ret);
        mixer_close(mix);
        (*env)->ReleaseStringUTFChars(env, controlName, name);
        return JNI_FALSE;
    }

    LOGI("Set mixer control '%s' = %d", name, value);

    mixer_close(mix);
    (*env)->ReleaseStringUTFChars(env, controlName, name);
    return JNI_TRUE;
}

/*
 * Set mixer control ENUM value by string
 *
 * @param card        Sound card number
 * @param controlName Mixer control name (e.g. "DEC1 MUX")
 * @param value       String value to set (e.g. "ZERO", "ADC1", "ADC2")
 * @return true on success
 */
JNIEXPORT jboolean JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_setMixerControlEnum(
        JNIEnv *env, jclass clazz,
        jint card, jstring controlName, jstring value) {

    const char *name = (*env)->GetStringUTFChars(env, controlName, NULL);
    const char *val = (*env)->GetStringUTFChars(env, value, NULL);
    if (!name || !val) {
        LOGE("Failed to get control name or value string");
        if (name) (*env)->ReleaseStringUTFChars(env, controlName, name);
        if (val) (*env)->ReleaseStringUTFChars(env, value, val);
        return JNI_FALSE;
    }

    LOGD("setMixerControlEnum: card=%d, control='%s', value='%s'", card, name, val);

    struct mixer *mix = mixer_open(card);
    if (!mix) {
        LOGE("Failed to open mixer for card %d", card);
        (*env)->ReleaseStringUTFChars(env, controlName, name);
        (*env)->ReleaseStringUTFChars(env, value, val);
        return JNI_FALSE;
    }

    struct mixer_ctl *ctl = mixer_get_ctl_by_name(mix, name);
    if (!ctl) {
        LOGE("Mixer control '%s' not found", name);
        mixer_close(mix);
        (*env)->ReleaseStringUTFChars(env, controlName, name);
        (*env)->ReleaseStringUTFChars(env, value, val);
        return JNI_FALSE;
    }

    int ret = mixer_ctl_set_enum_by_string(ctl, val);
    if (ret < 0) {
        LOGE("Failed to set mixer control '%s' to '%s': %d", name, val, ret);
        mixer_close(mix);
        (*env)->ReleaseStringUTFChars(env, controlName, name);
        (*env)->ReleaseStringUTFChars(env, value, val);
        return JNI_FALSE;
    }

    LOGI("Set mixer control '%s' = '%s'", name, val);

    mixer_close(mix);
    (*env)->ReleaseStringUTFChars(env, controlName, name);
    (*env)->ReleaseStringUTFChars(env, value, val);
    return JNI_TRUE;
}

/*
 * Get list of mixer controls (for device discovery)
 *
 * @param card Sound card number
 * @return String array of control names, or null on error
 */
JNIEXPORT jobjectArray JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_getMixerControls(
        JNIEnv *env, jclass clazz, jint card) {

    struct mixer *mix = mixer_open(card);
    if (!mix) {
        LOGE("Failed to open mixer for card %d", card);
        return NULL;
    }

    unsigned int count = mixer_get_num_ctls(mix);
    LOGD("Card %d has %u mixer controls", card, count);

    jclass stringClass = (*env)->FindClass(env, "java/lang/String");
    jobjectArray result = (*env)->NewObjectArray(env, count, stringClass, NULL);

    for (unsigned int i = 0; i < count; i++) {
        struct mixer_ctl *ctl = mixer_get_ctl(mix, i);
        if (ctl) {
            const char *name = mixer_ctl_get_name(ctl);
            jstring jname = (*env)->NewStringUTF(env, name ? name : "");
            (*env)->SetObjectArrayElement(env, result, i, jname);
            (*env)->DeleteLocalRef(env, jname);
        }
    }

    mixer_close(mix);
    return result;
}

/*
 * Check if audio is open
 */
JNIEXPORT jboolean JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_isOpen(JNIEnv *env, jclass clazz) {
    return (g_ctx != NULL && g_ctx->is_open) ? JNI_TRUE : JNI_FALSE;
}

/*
 * Get frame size in bytes
 */
JNIEXPORT jint JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_getFrameSize(JNIEnv *env, jclass clazz) {
    if (g_ctx == NULL || !g_ctx->is_open) {
        return 0;
    }
    /* period_size samples * channels * bytes_per_sample */
    return g_ctx->period_size * g_ctx->channels * (g_ctx->bits / 8);
}

/*
 * Get list of PCM devices for a card
 * Returns array of strings: "device_num: name (capture/playback)"
 *
 * @param card Sound card number
 * @param isCapture true for capture devices, false for playback
 * @return String array of device descriptions
 */
JNIEXPORT jobjectArray JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_getPcmDevices(
        JNIEnv *env, jclass clazz, jint card, jboolean isCapture) {

    /* Read /proc/asound/pcm to get device info */
    FILE *fp = fopen("/proc/asound/pcm", "r");
    if (!fp) {
        LOGE("Failed to open /proc/asound/pcm");
        return NULL;
    }

    /* First pass: count matching devices */
    char line[256];
    int count = 0;
    char cardStr[8];
    snprintf(cardStr, sizeof(cardStr), "%02d-", card);

    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, cardStr, 3) == 0) {
            /* Check if it's capture or playback */
            int hasCapture = (strstr(line, "capture") != NULL);
            int hasPlayback = (strstr(line, "playback") != NULL);
            if ((isCapture && hasCapture) || (!isCapture && hasPlayback)) {
                count++;
            }
        }
    }

    LOGD("Found %d %s devices on card %d", count, isCapture ? "capture" : "playback", card);

    /* Create result array */
    jclass stringClass = (*env)->FindClass(env, "java/lang/String");
    jobjectArray result = (*env)->NewObjectArray(env, count, stringClass, NULL);

    /* Second pass: fill array */
    rewind(fp);
    int idx = 0;
    while (fgets(line, sizeof(line), fp) && idx < count) {
        if (strncmp(line, cardStr, 3) == 0) {
            int hasCapture = (strstr(line, "capture") != NULL);
            int hasPlayback = (strstr(line, "playback") != NULL);
            if ((isCapture && hasCapture) || (!isCapture && hasPlayback)) {
                /* Parse: "00-36: msm-pcm-voice-v2 (*) : : playback 1 : capture 1" */
                int devNum = 0;
                char devName[128] = "";

                /* Get device number after dash */
                char *dash = strchr(line, '-');
                if (dash) {
                    devNum = atoi(dash + 1);
                }

                /* Get device name (between ": " and next " :") */
                char *nameStart = strchr(line, ':');
                if (nameStart) {
                    nameStart += 2; /* skip ": " */
                    char *nameEnd = strstr(nameStart, " :");
                    if (nameEnd) {
                        int len = nameEnd - nameStart;
                        if (len > 0 && len < sizeof(devName)) {
                            strncpy(devName, nameStart, len);
                            devName[len] = '\0';
                        }
                    }
                }

                /* Format: "36: msm-pcm-voice-v2" */
                char formatted[160];
                snprintf(formatted, sizeof(formatted), "%d: %s", devNum, devName);

                jstring jstr = (*env)->NewStringUTF(env, formatted);
                (*env)->SetObjectArrayElement(env, result, idx, jstr);
                (*env)->DeleteLocalRef(env, jstr);
                idx++;
            }
        }
    }

    fclose(fp);
    return result;
}

/*
 * Get number of sound cards
 */
JNIEXPORT jint JNICALL
Java_org_onetwoone_gateway_GsmAudioNative_getCardCount(JNIEnv *env, jclass clazz) {
    /* Check /proc/asound/cards */
    FILE *fp = fopen("/proc/asound/cards", "r");
    if (!fp) {
        return 0;
    }

    int maxCard = -1;
    char line[256];
    while (fgets(line, sizeof(line), fp)) {
        int cardNum;
        if (sscanf(line, " %d [", &cardNum) == 1) {
            if (cardNum > maxCard) maxCard = cardNum;
        }
    }

    fclose(fp);
    return maxCard + 1;
}
