package net.elfradio.elfremote;

import android.app.Application;
import android.content.Intent;

public final class ElfRemoteApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        startService(new Intent(this, ReportService.class));
    }
}
