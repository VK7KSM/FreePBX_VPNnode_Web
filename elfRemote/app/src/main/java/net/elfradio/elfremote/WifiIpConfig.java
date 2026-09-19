package net.elfradio.elfremote;

import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;

import java.net.InetAddress;
import java.util.List;

final class WifiIpConfig {
    static boolean restoreDhcp(WifiManager wifi) {
        WifiConfiguration cfg = current(wifi);
        if (cfg == null || wifi == null) return false;
        try {
            Class<?> ipc = Class.forName("android.net.IpConfiguration");
            Object ip = ipc.getConstructor().newInstance();
            Class<?> asg = Class.forName("android.net.IpConfiguration$IpAssignment");
            Object dhcp = enumOf(asg, "DHCP");
            ipc.getMethod("setIpAssignment", asg).invoke(ip, dhcp);
            Class<?> px = Class.forName("android.net.IpConfiguration$ProxySettings");
            ipc.getMethod("setProxySettings", px).invoke(ip, enumOf(px, "NONE"));
            cfg.getClass().getMethod("setIpConfiguration", ipc).invoke(cfg, ip);
            return commit(wifi, cfg);
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "wifi-dhcp " + e);
            return false;
        }
    }

    static boolean setStaticDns(WifiManager wifi, String ipv4, String gateway, String dns) {
        if (wifi == null || !HealPolicy.usableIpv4(ipv4) || !HealPolicy.usableIpv4(gateway)
                || dns == null || dns.length() == 0) return false;
        if (!HealPolicy.usableDns(dns) && !dns.startsWith("127.")) return false;
        WifiConfiguration cfg = current(wifi);
        if (cfg == null) return false;
        try {
            Class<?> ipc = Class.forName("android.net.IpConfiguration");
            Object ip = ipc.getConstructor().newInstance();
            Class<?> asg = Class.forName("android.net.IpConfiguration$IpAssignment");
            ipc.getMethod("setIpAssignment", asg).invoke(ip, enumOf(asg, "STATIC"));
            Class<?> sic = Class.forName("android.net.StaticIpConfiguration");
            Object s = sic.getConstructor().newInstance();
            Class<?> la = Class.forName("android.net.LinkAddress");
            Object link = la.getConstructor(InetAddress.class, int.class)
                    .newInstance(InetAddress.getByName(ipv4), 24);
            sic.getField("ipAddress").set(s, link);
            sic.getField("gateway").set(s, InetAddress.getByName(gateway));
            @SuppressWarnings("unchecked")
            List<InetAddress> servers = (List<InetAddress>) sic.getField("dnsServers").get(s);
            servers.clear();
            servers.add(InetAddress.getByName(dns));
            ipc.getMethod("setStaticIpConfiguration", sic).invoke(ip, s);
            Class<?> px = Class.forName("android.net.IpConfiguration$ProxySettings");
            ipc.getMethod("setProxySettings", px).invoke(ip, enumOf(px, "NONE"));
            cfg.getClass().getMethod("setIpConfiguration", ipc).invoke(cfg, ip);
            return commit(wifi, cfg);
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "wifi-static-dns " + e);
            return false;
        }
    }

    private static boolean commit(WifiManager wifi, WifiConfiguration cfg) {
        int id = wifi.updateNetwork(cfg);
        android.util.Log.i("elfRemote", "wifi-update id=" + id + " cfg=" + cfg.networkId);
        if (id == -1) {
            android.util.Log.w("elfRemote", "wifi-update rejected");
            return false;
        }
        wifi.saveConfiguration();
        wifi.disconnect();
        try { Thread.sleep(800); } catch (InterruptedException e) { /* ignore */ }
        if (cfg.networkId >= 0) wifi.enableNetwork(cfg.networkId, true);
        wifi.reconnect();
        return true;
    }

    private static WifiConfiguration current(WifiManager wifi) {
        if (wifi == null) return null;
        WifiInfo info = wifi.getConnectionInfo();
        if (info == null) return null;
        int nid = info.getNetworkId();
        android.util.Log.i("elfRemote", "wifi-current nid=" + nid);
        if (nid < 0) return null;
        List<WifiConfiguration> all = configured(wifi);
        if (all == null) {
            android.util.Log.w("elfRemote", "wifi-configs null");
            return null;
        }
        android.util.Log.i("elfRemote", "wifi-configs n=" + all.size());
        for (int i = 0; i < all.size(); i++) {
            WifiConfiguration c = all.get(i);
            if (c != null && c.networkId == nid) return c;
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<WifiConfiguration> configured(WifiManager wifi) {
        try {
            Object priv = wifi.getClass().getMethod("getPrivilegedConfiguredNetworks").invoke(wifi);
            if (priv instanceof List) {
                List<WifiConfiguration> p = (List<WifiConfiguration>) priv;
                if (p.size() > 0) return p;
            }
        } catch (Exception e) {
            android.util.Log.w("elfRemote", "wifi-priv " + e.getMessage());
        }
        return wifi.getConfiguredNetworks();
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Object enumOf(Class<?> cls, String name) {
        return Enum.valueOf((Class) cls, name);
    }

    private WifiIpConfig() {}
}
