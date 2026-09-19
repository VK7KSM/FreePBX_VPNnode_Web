package net.elfradio.elfremote;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkInfo;
import android.net.RouteInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.provider.Settings;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.List;

final class NetworkHealer {
    private static final String TAG = "elfRemote";
    private final Context ctx;
    private final PairingStore store;
    private final WifiManager wifi;
    private final ConnectivityManager cm;

    NetworkHealer(Context ctx, PairingStore store) {
        this.ctx = ctx.getApplicationContext();
        this.store = store;
        this.wifi = (WifiManager) this.ctx.getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
        this.cm = (ConnectivityManager) this.ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    HealPolicy.Facts observe() {
        HealPolicy.Facts f = new HealPolicy.Facts();
        NetworkInfo active = cm == null ? null : cm.getActiveNetworkInfo();
        f.otherNetworkConnected = active != null && active.isConnected()
                && active.getType() != ConnectivityManager.TYPE_WIFI;
        f.airplane = Settings.Global.getInt(ctx.getContentResolver(),
                Settings.Global.AIRPLANE_MODE_ON, 0) == 1;
        f.wifiEnabled = wifi != null && wifi.isWifiEnabled();
        if (f.otherNetworkConnected) return f;
        if (wifi != null) {
            WifiInfo info = wifi.getConnectionInfo();
            if (info != null) {
                f.ssid = info.getSSID() == null ? "" : info.getSSID();
                int ip = info.getIpAddress();
                if (ip != 0) f.ipv4 = HealPolicy.ipv4FromLe(ip);
            }
        }
        fillLink(f);
        if (!HealPolicy.usableIpv4(f.gateway) || f.ipv4.length() == 0
                || (!f.linkDnsBroken && !HealPolicy.usableDns(f.dns))) {
            fillDhcp(f);
        }
        fillTableRoute(f);
        if (!f.hasDefaultRoute) fillRoute(f);
        if (!HealPolicy.usableDns(f.dns)) f.dns = "";
        f.hasIpv4 = f.ipv4.length() > 0;
        f.iface = f.iface.length() == 0 ? "wlan0" : f.iface;
        f.ourFirewall = false;
        return f;
    }

    void saveSnapshot(HealPolicy.Facts f) {
        HealPolicy.Snapshot prev = HealPolicy.Snapshot.parse(store.netSnap());
        HealPolicy.Snapshot s = HealPolicy.sanitizeSnapshot(f, prev);
        if (s == null) return;
        store.saveNetSnap(s.encode());
    }

    String maybeHeal(boolean reportFailed) {
        HealPolicy.Facts f = observe();
        HealPolicy.Snapshot snap = HealPolicy.Snapshot.parse(store.netSnap());
        HealPolicy.Decision d = HealPolicy.decide(f, snap);
        logLine("obs netId=" + f.netId + " def=" + f.hasDefaultRoute
                + " gw=" + f.gateway + " dns=" + f.dns + " stage=" + d.stage
                + " action=" + d.action);
        if ("none".equals(d.action) && !reportFailed) {
            saveSnapshot(f);
            logLine("stage=" + d.stage + " action=none healthy");
            return d.stage;
        }
        if ("wait_physical".equals(d.action) || "wait_no_snapshot".equals(d.action)
                || "none".equals(d.action)) {
            logLine("stage=" + d.stage + " action=" + d.action + " " + d.reason);
            store.setLastStatus("自愈" + d.stage + " " + d.reason);
            return d.stage;
        }
        long now = System.currentTimeMillis();
        String blob = store.healBlob();
        if (!HealPolicy.allowed(blob, d.stage, now)) {
            logLine("stage=" + d.stage + " action=cooldown");
            store.setLastStatus("自愈" + d.stage + "冷却");
            return d.stage;
        }
        store.saveHealBlob(HealPolicy.record(blob, d.stage, now));
        boolean ok = apply(d, f);
        logLine("stage=" + d.stage + " action=" + d.action + " result=" + (ok ? "ok" : "fail")
                + " " + d.reason);
        store.setLastStatus("自愈" + d.stage + (ok ? "已执行" : "失败"));
        return d.stage;
    }

    private boolean apply(HealPolicy.Decision d, HealPolicy.Facts f) {
        if ("enable_wifi".equals(d.action)) {
            if (wifi == null) return false;
            boolean a = wifi.setWifiEnabled(true);
            try { Thread.sleep(1500); } catch (InterruptedException e) { /* ignore */ }
            wifi.reconnect();
            return a;
        }
        if ("dhcp".equals(d.action)) {
            if (wifi != null) {
                wifi.reconnect();
                wifi.reassociate();
            }
            return su("svc wifi enable");
        }
        if ("restore_route".equals(d.action)) {
            String iface = f.iface.length() == 0 ? "wlan0" : f.iface;
            String cmd = HealPolicy.restoreRouteCmd(iface, d.gateway);
            if (cmd.length() == 0) return false;
            logLine("cmd=" + cmd);
            boolean ok = su(cmd);
            String ndc = HealPolicy.restoreRouteNdcCmd(f.netId, iface, d.gateway);
            if (ndc.length() > 0) {
                logLine("cmd=" + ndc);
                if (su(ndc)) ok = true;
            }
            return ok;
        }
        if ("restore_dns".equals(d.action)) {
            String tool = HealPolicy.wifiToolCmd("dhcp", "", "", "");
            logLine("cmd=" + tool);
            boolean wifiOk = tool.length() > 0 && su(tool);
            logLine("wifi-dhcp=" + (wifiOk ? "ok" : "fail"));
            String cmd = HealPolicy.restoreDnsCmd(f.netId, d.dns);
            if (cmd.length() > 0) {
                logLine("cmd=" + cmd);
                su(cmd);
            }
            return wifiOk;
        }
        if ("clear_our_firewall".equals(d.action)) {
            logLine("L6 skip: no local firewall owned by elfRemote");
            return true;
        }
        return false;
    }

    private void fillDhcp(HealPolicy.Facts f) {
        if (wifi == null) return;
        try {
            Object d = wifi.getClass().getMethod("getDhcpInfo").invoke(wifi);
            if (d == null) return;
            int ip = d.getClass().getField("ipAddress").getInt(d);
            int gw = d.getClass().getField("gateway").getInt(d);
            int dns1 = d.getClass().getField("dns1").getInt(d);
            int dns2 = d.getClass().getField("dns2").getInt(d);
            if (f.ipv4.length() == 0) f.ipv4 = HealPolicy.ipv4FromLe(ip);
            if (f.gateway.length() == 0) f.gateway = HealPolicy.ipv4FromLe(gw);
            if (!f.linkDnsBroken && !HealPolicy.usableDns(f.dns)) {
                String d1 = HealPolicy.ipv4FromLe(dns1);
                String d2 = HealPolicy.ipv4FromLe(dns2);
                if (HealPolicy.usableDns(d1)) f.dns = d1;
                else if (HealPolicy.usableDns(d2)) f.dns = d2;
            }
        } catch (Exception e) {
            Log.w(TAG, "dhcp info skipped: " + e.getMessage());
        }
    }

    private void fillTableRoute(HealPolicy.Facts f) {
        String iface = f.iface.length() == 0 ? "wlan0" : f.iface;
        if (!iface.matches("[a-zA-Z0-9_]+")) iface = "wlan0";
        f.iface = iface;
        try {
            java.net.NetworkInterface networkInterface = java.net.NetworkInterface.getByName(iface);
            if (networkInterface != null) f.ifaceIndex = networkInterface.getIndex();
        } catch (Exception error) { logLine("interface-index-unavailable"); }
        String text = execOut(new String[]{"/system/bin/ip", "route", "show", "table", "all"});
        HealPolicy.applyKernelTable(f, text == null ? "" : text, text != null);
        String one = text == null ? "null" : text.replace('\n', '|').trim();
        if (one.length() > 160) one = one.substring(0, 160);
        logLine("krt=" + one);
    }

    private void fillRoute(HealPolicy.Facts f) {
        try {
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.FileReader("/proc/net/route"));
            try {
                String line;
                while ((line = r.readLine()) != null) {
                    String[] p = line.split("\\s+");
                    if (p.length < 3) continue;
                    String expectedIface = f.iface.length() == 0 ? "wlan0" : f.iface;
                    if (!expectedIface.equals(p[0])) continue;
                    if (!"00000000".equals(p[1])) continue;
                    f.hasDefaultRoute = true;
                    if (p[0] != null && p[0].length() > 0 && !"Iface".equals(p[0])) f.iface = p[0];
                    f.gateway = hexIpv4Le(p[2]);
                    return;
                }
            } finally {
                r.close();
            }
        } catch (Exception e) {
            f.hasDefaultRoute = false;
        }
    }

    private static String hexIpv4Le(String hex) {
        if (hex == null || hex.length() != 8) return "";
        try {
            int v = (int) Long.parseLong(hex, 16);
            return HealPolicy.ipv4FromLe(v);
        } catch (NumberFormatException e) {
            return "";
        }
    }

    private void fillLink(HealPolicy.Facts f) {
        if (cm == null) return;
        Network chosen = pickWifiNetwork();
        if (chosen == null) return;
        f.netId = HealPolicy.parseNetId(String.valueOf(chosen));
        if (f.netId <= 0) {
            try {
                java.lang.reflect.Field field = chosen.getClass().getDeclaredField("netId");
                field.setAccessible(true);
                int v = field.getInt(chosen);
                if (v > 0) f.netId = v;
            } catch (Exception e) {
                /* keep parsed value */
            }
        }
        LinkProperties lp = cm.getLinkProperties(chosen);
        if (lp == null) return;
        if (lp.getInterfaceName() != null && lp.getInterfaceName().length() > 0) {
            f.iface = lp.getInterfaceName();
        }
        List<LinkAddress> addrs = lp.getLinkAddresses();
        if (addrs != null) {
            for (int i = 0; i < addrs.size(); i++) {
                InetAddress a = addrs.get(i).getAddress();
                if (a instanceof Inet4Address && !a.isLoopbackAddress()) {
                    f.ipv4 = a.getHostAddress();
                    break;
                }
            }
        }
        List<RouteInfo> routes = lp.getRoutes();
        if (routes != null) {
            for (int i = 0; i < routes.size(); i++) {
                RouteInfo r = routes.get(i);
                InetAddress gw = r.getGateway();
                if (r.isDefaultRoute() && gw instanceof Inet4Address && HealPolicy.usableIpv4(gw.getHostAddress())) {
                    f.hasDefaultRoute = true;
                    f.gateway = gw.getHostAddress();
                    break;
                }
            }
        }
        List<InetAddress> dns = lp.getDnsServers();
        java.util.ArrayList<String> servers = new java.util.ArrayList<>();
        if (dns != null) {
            for (int i = 0; i < dns.size(); i++) {
                InetAddress d = dns.get(i);
                if (d instanceof Inet4Address) servers.add(d.getHostAddress());
            }
        }
        HealPolicy.applyLinkDns(f, servers);
    }

    private Network pickWifiNetwork() {
        if (cm == null) return null;
        Network active = cm.getActiveNetwork();
        if (isWifi(active)) return active;
        Network[] all = cm.getAllNetworks();
        if (all == null) return null;
        for (int i = 0; i < all.length; i++) {
            if (isWifi(all[i])) return all[i];
        }
        return null;
    }

    private boolean isWifi(Network n) {
        if (n == null || cm == null) return false;
        NetworkInfo ni = cm.getNetworkInfo(n);
        return ni != null && ni.getType() == ConnectivityManager.TYPE_WIFI;
    }

    private static String withPath(String cmd) {
        return "export PATH=/system/bin:/system/xbin:/sbin:/vendor/bin:$PATH; " + cmd;
    }

    private String execOut(String[] argv) {
        try {
            ProcessBuilder pb = new ProcessBuilder(argv);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            InputStream in = p.getInputStream();
            byte[] buf = new byte[256];
            int n;
            while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
            p.waitFor();
            String t = bos.toString("UTF-8");
            if (t == null || t.trim().length() == 0) return null;
            return t;
        } catch (Exception e) {
            return null;
        }
    }

    private String suOut(String cmd) {
        try {
            ProcessBuilder pb = new ProcessBuilder("su", "-c", withPath(cmd));
            pb.redirectErrorStream(true);
            Process p = pb.start();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            InputStream in = p.getInputStream();
            byte[] buf = new byte[256];
            int n;
            while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
            p.waitFor();
            String t = bos.toString("UTF-8");
            if (t == null || t.trim().length() == 0) return null;
            return t;
        } catch (Exception e) {
            return null;
        }
    }

    boolean runPrivileged(String cmd) {
        return su(cmd);
    }

    private boolean su(String cmd) {
        if (suDirect(cmd)) return true;
        return suViaWatchdog(cmd);
    }

    private boolean suDirect(String cmd) {
        String[] bins = new String[]{"/sbin/su", "su"};
        for (int i = 0; i < bins.length; i++) {
            try {
                ProcessBuilder pb = new ProcessBuilder(bins[i], "-c", withPath(cmd));
                pb.redirectErrorStream(true);
                Process p = pb.start();
                InputStream in = p.getInputStream();
                byte[] buf = new byte[128];
                while (in.read(buf) >= 0) { /* drain */ }
                if (p.waitFor() == 0) return true;
            } catch (Exception e) {
                Log.w(TAG, "heal su failed: " + e.getMessage());
            }
        }
        return false;
    }

    private boolean suViaWatchdog(String cmd) {
        File dir = new File("/data/local/elfremote");
        File cmdf = new File(dir, "heal.cmd");
        File rcf = new File(dir, "heal.rc");
        try {
            if (cmdf.exists() || new File(dir, "heal.running").exists() || new File(dir, "update.running").exists()) {
                logLine("wd-busy");
                return false;
            }
            if (rcf.exists() && !rcf.delete()) {
                logLine("wd-rc-stale");
            }
            File tmp = new File(dir, "heal.cmd.tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write((withPath(cmd) + "\n").getBytes("UTF-8"));
                out.getFD().sync();
            } finally {
                out.close();
            }
            if (!tmp.renameTo(cmdf)) {
                logLine("wd-cmd-rename-fail");
                return false;
            }
            long deadline = System.currentTimeMillis() + 20000L;
            while (System.currentTimeMillis() < deadline) {
                if (rcf.isFile()) {
                    String rc = readSmall(rcf).trim();
                    if (rc.length() == 0) {
                        try { Thread.sleep(200); } catch (InterruptedException e) { return false; }
                        continue;
                    }
                    logLine("wd-rc=" + rc);
                    return "0".equals(rc);
                }
                try { Thread.sleep(200); } catch (InterruptedException e) { return false; }
            }
            logLine("wd-timeout");
            return false;
        } catch (Exception e) {
            logLine("wd-fail " + e.getMessage());
            return false;
        }
    }

    private static String readSmall(File f) {
        try {
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            try {
                byte[] buf = new byte[32];
                int n = in.read(buf);
                if (n <= 0) return "";
                return new String(buf, 0, n, "UTF-8");
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return "";
        }
    }

    private void logLine(String line) {
        Log.i(TAG, "heal " + line);
        RuntimeLog.event("heal " + line);
    }
}
