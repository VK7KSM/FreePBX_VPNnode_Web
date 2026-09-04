package org.onetwoone.gateway;

import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;

/** Read-only diagnostics used while identifying Pixel 3 XL call-audio routes. */
public final class AudioDiagnostics {
    private static final String TAG = "PixelAudioDiag";
    private static final int MAX_PROC_LINES = 256;

    private AudioDiagnostics() {}

    public static void logSnapshot(int card, int captureDevice, int playbackDevice,
                                   String captureRoute, String injectionRoute) {
        Log.i(TAG, "Selected card=" + card + ", capture=" + captureDevice +
            " route=" + captureRoute + ", playback=" + playbackDevice +
            " route=" + injectionRoute);
        logProcFile("/proc/asound/cards");
        logProcFile("/proc/asound/pcm");
        logSoundNodes();
    }

    private static void logProcFile(String path) {
        File file = new File(path);
        if (!file.isFile() || !file.canRead()) {
            Log.w(TAG, path + " is not readable by the app");
            return;
        }

        try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
            StringBuilder value = new StringBuilder();
            String line;
            int count = 0;
            while (count++ < MAX_PROC_LINES && (line = reader.readLine()) != null) {
                value.append(line).append('\n');
            }
            Log.i(TAG, path + ":\n" + value.toString().trim());
        } catch (IOException e) {
            Log.w(TAG, "Failed to read " + path + ": " + e.getMessage());
        }
    }

    private static void logSoundNodes() {
        File directory = new File("/dev/snd");
        File[] nodes = directory.listFiles();
        if (nodes == null) {
            Log.w(TAG, "/dev/snd cannot be listed by the app");
            return;
        }

        StringBuilder value = new StringBuilder();
        for (File node : nodes) {
            value.append(node.getName())
                .append(" read=").append(node.canRead())
                .append(" write=").append(node.canWrite())
                .append('\n');
        }
        Log.i(TAG, "/dev/snd:\n" + value.toString().trim());
    }
}
