package net.elfradio.elfremote;

import android.app.Application;

public final class ElfRemoteApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        if (BuildConfig.VERSION_NAME != null && BuildConfig.VERSION_NAME.contains("-bad")) {
            throw new RuntimeException("unhealthy-lab-build");
        }
    }
}
