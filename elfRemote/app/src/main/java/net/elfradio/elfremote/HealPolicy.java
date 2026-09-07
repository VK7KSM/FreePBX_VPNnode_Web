package net.elfradio.elfremote;

final class HealPolicy {
    static final long COOL_MS = 10L * 60L * 1000L;
    static final int COOL_MAX = 3;

    static final class Facts {
        boolean airplane;
        boolean wifiEnabled;
        boolean hasIpv4;
        boolean hasDefaultRoute;
        boolean ourFirewall;
        int netId;
        String iface = "";
        String ipv4 = "";
        String gateway = "";
        String dns = "";
        String ssid = "";
        boolean linkDnsBroken;
    }

    static final class Snapshot {
        String iface = "";
        String ipv4 = "";
        String gateway = "";
        String dns = "";
        String ssid = "";

        String encode() {
            return nz(iface) + "|" + nz(ipv4) + "|" + nz(gateway) + "|" + nz(dns) + "|" + nz(ssid);
        }

        static Snapshot parse(String raw) {
            if (raw == null || raw.length() == 0) return null;
            String[] p = raw.split("\\|", -1);
            if (p.length < 4) return null;
            Snapshot s = new Snapshot();
            s.iface = p[0];
            s.ipv4 = p[1];
            s.gateway = p[2];
            s.dns = p[3];
            s.ssid = p.length > 4 ? p[4] : "";
            if (s.ipv4.length() == 0 && s.gateway.length() == 0) return null;
            return s;
        }
    }

    static final class Decision {
        final String stage;
        final String action;
        final String gateway;
        final String dns;
        final String reason;

        Decision(String stage, String action, String gateway, String dns, String reason) {
            this.stage = stage;
            this.action = action;
            this.gateway = gateway == null ? "" : gateway;
            this.dns = dns == null ? "" : dns;
            this.reason = reason == null ? "" : reason;
        }
    }

    static Decision decide(Facts now, Snapshot snap) {
        if (now == null || now.airplane) {
            return new Decision("L1", "wait_physical", "", "", "airplane-or-empty");
        }
        if (!now.wifiEnabled) {
            return new Decision("L2", "enable_wifi", "", "", "wifi-off");
        }
        if (!now.hasIpv4) {
            return new Decision("L3", "dhcp", "", "", "no-ipv4");
        }
        if (dnsBroken(now)) {
            String dns = (snap != null && usableDns(snap.dns)) ? snap.dns : "";
            if (!usableDns(dns)) {
                return new Decision("L5", "wait_no_snapshot", "", "", "bad-dns-no-snap");
            }
            return new Decision("L5", "restore_dns", "", dns, "dns-mismatch");
        }
        if (!now.hasDefaultRoute) {
            String gw = "";
            if (snap != null && usableIpv4(snap.gateway)) gw = snap.gateway;
            if (!usableIpv4(gw) && usableIpv4(now.gateway)) gw = now.gateway;
            if (!usableIpv4(gw)) {
                return new Decision("L4", "wait_no_snapshot", "", "", "no-route-no-snap");
            }
            return new Decision("L4", "restore_route", gw, "", "no-route");
        }
        if (now.ourFirewall) {
            return new Decision("L6", "clear_our_firewall", "", "", "our-fw");
        }
        return new Decision("L9", "none", "", "", "healthy");
    }

    static boolean allowed(String blob, String stage, long nowMs) {
        return count(blob, stage, nowMs) < COOL_MAX;
    }

    static String record(String blob, String stage, long nowMs) {
        if (stage == null || stage.length() == 0) return blob == null ? "" : blob;
        String cur = blob == null ? "" : blob;
        if (cur.length() > 0) cur += ";";
        return prune(cur + stage + ":" + nowMs, nowMs);
    }

    static int count(String blob, String stage, long nowMs) {
        String p = prune(blob, nowMs);
        if (p.length() == 0 || stage == null) return 0;
        int n = 0;
        String[] parts = p.split(";");
        for (int i = 0; i < parts.length; i++) {
            if (parts[i].startsWith(stage + ":")) n++;
        }
        return n;
    }

    static String prune(String blob, long nowMs) {
        if (blob == null || blob.length() == 0) return "";
        StringBuilder sb = new StringBuilder();
        String[] parts = blob.split(";");
        for (int i = 0; i < parts.length; i++) {
            String e = parts[i];
            int c = e.lastIndexOf(':');
            if (c <= 0) continue;
            long t;
            try {
                t = Long.parseLong(e.substring(c + 1));
            } catch (NumberFormatException ex) {
                continue;
            }
            if (nowMs - t > COOL_MS) continue;
            if (sb.length() > 0) sb.append(';');
            sb.append(e);
        }
        return sb.toString();
    }

    static String ipv4FromLe(int v) {
        if (v == 0) return "";
        return (v & 255) + "." + ((v >> 8) & 255) + "." + ((v >> 16) & 255) + "." + ((v >> 24) & 255);
    }

    static boolean usableDns(String dns) {
        return usableIpv4(dns);
    }

    static boolean usableIpv4(String ip) {
        if (ip == null) return false;
        String t = ip.trim();
        if (t.length() == 0) return false;
        if (t.startsWith("127.") || t.equals("0.0.0.0")) return false;
        String[] p = t.split("\\.");
        if (p.length != 4) return false;
        for (int i = 0; i < 4; i++) {
            try {
                int n = Integer.parseInt(p[i]);
                if (n < 0 || n > 255) return false;
            } catch (NumberFormatException e) {
                return false;
            }
        }
        return true;
    }

    static Snapshot sanitizeSnapshot(Facts f, Snapshot previous) {
        if (f == null || !f.hasIpv4) return null;
        String gw = nz(f.gateway);
        if (!f.hasDefaultRoute && empty(gw)) return null;
        Snapshot s = new Snapshot();
        s.iface = empty(f.iface) ? "wlan0" : f.iface;
        s.ipv4 = nz(f.ipv4);
        if (usableIpv4(gw)) s.gateway = gw;
        else if (previous != null && usableIpv4(previous.gateway)) s.gateway = previous.gateway;
        else s.gateway = "";
        if (usableDns(f.dns)) s.dns = f.dns.trim();
        else if (previous != null && usableDns(previous.dns)) s.dns = previous.dns;
        else s.dns = "";
        s.ssid = nz(f.ssid);
        if (!usableIpv4(s.gateway)) return null;
        return s;
    }

    static String restoreRouteCmd(String iface, String gateway) {
        if (empty(iface) || !usableIpv4(gateway)) return "";
        if (!iface.matches("[a-zA-Z0-9_]+")) return "";
        return "ip route replace default via " + gateway.trim() + " dev " + iface + " table " + iface;
    }

    static String restoreRouteNdcCmd(int netId, String iface, String gateway) {
        if (netId <= 0 || empty(iface) || !usableIpv4(gateway)) return "";
        if (!iface.matches("[a-zA-Z0-9_]+")) return "";
        return "ndc network route add " + netId + " " + iface + " 0.0.0.0/0 " + gateway.trim();
    }

    static String restoreDnsCmd(int netId, String dns) {
        if (netId <= 0 || !usableDns(dns)) return "";
        return "ndc resolver setnetdns " + netId + " '' " + dns.trim();
    }

    static final String WIFI_TOOL_APK = "/system/app/ElfRemote/ElfRemote.apk";
    static final String WIFI_TOOL_CLASS = "net.elfradio.elfremote.WifiIpTool";

    static String wifiToolCmd(String mode, String ipv4, String gateway, String dns) {
        String launch = "/system/bin/app_process -Djava.class.path=" + WIFI_TOOL_APK
                + " /system/bin " + WIFI_TOOL_CLASS;
        if ("dhcp".equals(mode)) {
            return "su 1000 -c '" + launch + " dhcp'";
        }
        if ("static".equals(mode) && ipv4Token(ipv4) && ipv4Token(gateway) && ipv4Token(dns)) {
            return "su 1000 -c '" + launch + " static " + ipv4.trim() + " "
                    + gateway.trim() + " " + dns.trim() + "'";
        }
        return "";
    }

    static void applyLinkDns(Facts f, java.util.List<String> servers) {
        if (f == null || servers == null || servers.isEmpty()) return;
        for (int i = 0; i < servers.size(); i++) {
            String s = servers.get(i);
            if (usableDns(s)) {
                f.dns = s.trim();
                f.linkDnsBroken = false;
                return;
            }
        }
        f.dns = "";
        f.linkDnsBroken = true;
    }

    static boolean ipv4Token(String ip) {
        if (ip == null) return false;
        String t = ip.trim();
        if (!t.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) return false;
        String[] p = t.split("\\.");
        for (int i = 0; i < p.length; i++) {
            try {
                int n = Integer.parseInt(p[i]);
                if (n < 0 || n > 255) return false;
            } catch (NumberFormatException e) {
                return false;
            }
        }
        return true;
    }

    static boolean kernelTableTextOk(String text) {
        if (text == null) return false;
        String t = text.trim();
        if (t.length() == 0) return false;
        if (t.contains("Error:") || t.contains("invalid")) return false;
        return true;
    }

    static void applyKernelTable(Facts f, String tableText, boolean tableReadOk) {
        if (f == null || !tableReadOk || !kernelTableTextOk(tableText)) return;
        String gw = defaultGatewayFromIpRoute(tableText);
        if (usableIpv4(gw)) {
            f.hasDefaultRoute = true;
            f.gateway = gw;
            return;
        }
        f.hasDefaultRoute = false;
    }

    static String defaultGatewayFromIpRoute(String text) {
        if (text == null) return "";
        String[] lines = text.split("\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (!line.startsWith("default ")) continue;
            String[] p = line.split("\\s+");
            for (int j = 0; j < p.length - 1; j++) {
                if ("via".equals(p[j]) && usableIpv4(p[j + 1])) return p[j + 1];
            }
        }
        return "";
    }

    static int parseNetId(String raw) {
        if (raw == null || raw.length() == 0) return 0;
        String t = raw.trim();
        if (t.matches("\\d+")) {
            try {
                int v = Integer.parseInt(t);
                return v > 0 ? v : 0;
            } catch (NumberFormatException e) {
                return 0;
            }
        }
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(?:netId\\s*=|network\\{)\\s*(\\d+)")
                .matcher(t);
        if (!m.find()) return 0;
        try {
            int v = Integer.parseInt(m.group(1));
            return v > 0 ? v : 0;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static boolean dnsBroken(Facts now) {
        return now == null || !usableDns(now.dns);
    }

    private static boolean empty(String s) {
        return s == null || s.length() == 0;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private HealPolicy() {}
}
