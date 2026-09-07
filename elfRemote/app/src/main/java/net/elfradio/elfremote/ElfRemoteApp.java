package net.elfradio.elfremote;

import android.app.Application;

public final class ElfRemoteApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        RuntimeLog.initialize(new java.io.File(getFilesDir(), "runtime-log"), BuildConfig.VERSION_NAME);
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        if (previous != null) Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            RuntimeLog.error("uncaught_exception", error);
            previous.uncaughtException(thread, error);
        });
        if (BuildConfig.VERSION_NAME != null && BuildConfig.VERSION_NAME.contains("-bad")) {
            throw new RuntimeException("unhealthy-lab-build");
        }
    }
}
