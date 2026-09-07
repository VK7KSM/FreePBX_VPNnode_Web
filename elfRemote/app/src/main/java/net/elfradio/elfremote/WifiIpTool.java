package net.elfradio.elfremote;

import android.content.Context;
import android.net.wifi.WifiManager;

/** Privileged CLI: run as uid 1000 via app_process so WifiConfigManager allows the update. */
public final class WifiIpTool {
    public static void main(String[] args) {
        int rc = 2;
        try {
            rc = run(args);
        } catch (Throwable t) {
            System.err.println("wifi-tool " + t);
            rc = 3;
        }
        System.exit(rc);
    }

    static int run(String[] args) throws Exception {
        if (args == null || args.length < 1) {
            System.err.println("usage: dhcp | static ipv4 gw dns");
            return 2;
        }
        try {
            Class.forName("android.os.Looper").getMethod("prepareMainLooper").invoke(null);
        } catch (Exception e) {
            /* already prepared */
        }
        Object at = Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
        Context ctx = (Context) at.getClass().getMethod("getSystemContext").invoke(at);
        WifiManager wifi = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        boolean ok;
        if ("dhcp".equals(args[0])) {
            ok = WifiIpConfig.restoreDhcp(wifi);
        } else if ("static".equals(args[0]) && args.length >= 4) {
            ok = WifiIpConfig.setStaticDns(wifi, args[1], args[2], args[3]);
        } else {
            System.err.println("usage: dhcp | static ipv4 gw dns");
            return 2;
        }
        System.out.println("wifi-tool " + args[0] + " result=" + (ok ? "ok" : "fail"));
        return ok ? 0 : 1;
    }

    private WifiIpTool() {}
}
