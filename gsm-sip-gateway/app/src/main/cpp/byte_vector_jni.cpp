#include <jni.h>

#include <algorithm>
#include <vector>

namespace {
using ByteVector = std::vector<unsigned char>;
}

extern "C" JNIEXPORT jint JNICALL
Java_org_pjsip_pjsua2_ByteVectorNative_copyFromJava(
        JNIEnv *env, jclass, jlong vectorPtr, jbyteArray source, jint length) {
    if (vectorPtr == 0 || source == nullptr || length < 0) {
        return -1;
    }

    const jsize sourceLength = env->GetArrayLength(source);
    const jint copyLength = std::min(length, sourceLength);
    auto *vector = reinterpret_cast<ByteVector *>(vectorPtr);
    vector->resize(static_cast<size_t>(copyLength));
    if (copyLength > 0) {
        env->GetByteArrayRegion(
                source, 0, copyLength, reinterpret_cast<jbyte *>(vector->data()));
        if (env->ExceptionCheck()) {
            return -1;
        }
    }
    return copyLength;
}

extern "C" JNIEXPORT jint JNICALL
Java_org_pjsip_pjsua2_ByteVectorNative_copyToJava(
        JNIEnv *env, jclass, jlong vectorPtr, jbyteArray destination, jint length) {
    if (vectorPtr == 0 || destination == nullptr || length < 0) {
        return -1;
    }

    auto *vector = reinterpret_cast<ByteVector *>(vectorPtr);
    const jsize destinationLength = env->GetArrayLength(destination);
    const jint copyLength = std::min(
            length,
            std::min(destinationLength, static_cast<jint>(vector->size())));
    if (copyLength > 0) {
        env->SetByteArrayRegion(
                destination, 0, copyLength,
                reinterpret_cast<const jbyte *>(vector->data()));
        if (env->ExceptionCheck()) {
            return -1;
        }
    }
    return copyLength;
}
