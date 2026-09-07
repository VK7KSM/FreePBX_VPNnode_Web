package net.elfradio.elfremote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class HealPolicyTest {
    @Test
    public void cellularOrEthernetDoesNotEnableWifiOrSaveWifiSnapshot() {
        HealPolicy.Facts f = facts();
        f.otherNetworkConnected = true;
        f.wifiEnabled = false;
        f.hasIpv4 = true;
        assertEquals("none", HealPolicy.decide(f, snap()).action);
        assertEquals(null, HealPolicy.sanitizeSnapshot(f, snap()));
    }

    @Test
    public void differentOrUnknownWifiCannotRestoreOldGatewayOrDns() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true; f.hasIpv4 = true; f.dns = "8.8.8.8";
        f.ssid = "different-network";
        assertEquals("wait_no_snapshot", HealPolicy.decide(f, snap()).action);
        f.dns = "127.0.0.1";
        assertEquals("wait_no_snapshot", HealPolicy.decide(f, snap()).action);
        f.ssid = "";
        assertEquals("wait_no_snapshot", HealPolicy.decide(f, snap()).action);
        f.gateway = "192.168.2.1"; f.hasDefaultRoute = true;
        assertEquals("", HealPolicy.sanitizeSnapshot(f, snap()).dns);
    }
    @Test
    public void airplaneIsPhysicalAndDoesNotDhcp() {
        HealPolicy.Facts f = facts();
        f.airplane = true;
        f.wifiEnabled = false;
        HealPolicy.Decision d = HealPolicy.decide(f, snap());
        assertEquals("L1", d.stage);
        assertEquals("wait_physical", d.action);
    }

    @Test
    public void softwareWifiOffEnablesInterface() {
        HealPolicy.Facts f = facts();
        f.airplane = false;
        f.wifiEnabled = false;
        HealPolicy.Decision d = HealPolicy.decide(f, snap());
        assertEquals("L2", d.stage);
        assertEquals("enable_wifi", d.action);
    }

    @Test
    public void wifiUpNoIpv4RequestsDhcp() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true;
        f.hasIpv4 = false;
        f.hasDefaultRoute = false;
        HealPolicy.Decision d = HealPolicy.decide(f, snap());
        assertEquals("L3", d.stage);
        assertEquals("dhcp", d.action);
    }

    @Test
    public void ipv4WithoutRouteRestoresSnapshotGateway() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true;
        f.hasIpv4 = true;
        f.hasDefaultRoute = false;
        f.dns = "8.8.8.8";
        HealPolicy.Decision d = HealPolicy.decide(f, snap());
        assertEquals("L4", d.stage);
        assertEquals("restore_route", d.action);
        assertEquals("192.168.1.1", d.gateway);
    }

    @Test
    public void noSnapshotDoesNotInventGateway() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true;
        f.hasIpv4 = true;
        f.hasDefaultRoute = false;
        f.dns = "8.8.8.8";
        HealPolicy.Decision d = HealPolicy.decide(f, null);
        assertEquals("L4", d.stage);
        assertEquals("wait_no_snapshot", d.action);
        assertEquals("", d.gateway);
    }

    @Test
    public void loopbackDnsRestoresSnapshotDns() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true;
        f.hasIpv4 = true;
        f.hasDefaultRoute = true;
        f.dns = "127.0.0.1";
        HealPolicy.Decision d = HealPolicy.decide(f, snap());
        assertEquals("L5", d.stage);
        assertEquals("restore_dns", d.action);
        assertEquals("8.8.8.8", d.dns);
    }

    @Test
    public void noOurFirewallHealthyIsL9() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true;
        f.hasIpv4 = true;
        f.hasDefaultRoute = true;
        f.dns = "8.8.8.8";
        f.ourFirewall = false;
        HealPolicy.Decision d = HealPolicy.decide(f, snap());
        assertEquals("L9", d.stage);
        assertEquals("none", d.action);
    }

    @Test
    public void cooldownBlocksFourthSameStageWithinTenMinutes() {
        String blob = "";
        long t = 1_000_000L;
        blob = HealPolicy.record(blob, "L2", t);
        blob = HealPolicy.record(blob, "L2", t + 1000);
        blob = HealPolicy.record(blob, "L2", t + 2000);
        assertFalse(HealPolicy.allowed(blob, "L2", t + 3000));
        assertTrue(HealPolicy.allowed(blob, "L2", t + 11 * 60 * 1000L));
        assertTrue(HealPolicy.allowed(blob, "L3", t + 3000));
    }

    @Test
    public void snapshotRoundTrip() {
        HealPolicy.Snapshot s = snap();
        HealPolicy.Snapshot b = HealPolicy.Snapshot.parse(s.encode());
        assertEquals(s.iface, b.iface);
        assertEquals(s.ipv4, b.ipv4);
        assertEquals(s.gateway, b.gateway);
        assertEquals(s.dns, b.dns);
        assertEquals(s.ssid, b.ssid);
    }

    @Test
    public void usableDnsRejectsLoopbackAndZero() {
        assertFalse(HealPolicy.usableDns("127.0.0.1"));
        assertFalse(HealPolicy.usableDns("0.0.0.0"));
        assertFalse(HealPolicy.usableDns(""));
        assertFalse(HealPolicy.usableDns(null));
        assertTrue(HealPolicy.usableDns("192.168.2.1"));
    }

    @Test
    public void poisonedSnapshotDnsIsNotRestored() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true;
        f.hasIpv4 = true;
        f.hasDefaultRoute = true;
        f.dns = "127.0.0.1";
        HealPolicy.Snapshot s = snap();
        s.dns = "127.0.0.1";
        HealPolicy.Decision d = HealPolicy.decide(f, s);
        assertEquals("L5", d.stage);
        assertEquals("wait_no_snapshot", d.action);
        assertFalse(HealPolicy.usableDns(d.dns));
    }

    @Test
    public void sanitizeSnapshotKeepsPreviousDnsWhenCurrentIsLoopback() {
        HealPolicy.Facts f = facts();
        f.hasIpv4 = true;
        f.hasDefaultRoute = true;
        f.ipv4 = "192.168.2.72";
        f.gateway = "192.168.2.1";
        f.dns = "127.0.0.1";
        HealPolicy.Snapshot s = HealPolicy.sanitizeSnapshot(f, snap());
        assertEquals("192.168.2.1", s.gateway);
        assertEquals("8.8.8.8", s.dns);
        assertFalse(s.encode().contains("127."));
    }

    @Test
    public void sanitizeSnapshotRefusesMissingGateway() {
        HealPolicy.Facts f = facts();
        f.hasIpv4 = true;
        f.hasDefaultRoute = false;
        f.ipv4 = "192.168.2.72";
        f.gateway = "";
        f.dns = "192.168.2.1";
        assertEquals(null, HealPolicy.sanitizeSnapshot(f, null));
    }

    @Test
    public void routeRestoreUsesIfaceTableNotMain() {
        assertEquals(
                "ip route replace default via 192.168.2.1 dev wlan0 table wlan0",
                HealPolicy.restoreRouteCmd("wlan0", "192.168.2.1"));
        assertEquals("", HealPolicy.restoreRouteCmd("wlan0", "127.0.0.1"));
        assertEquals("", HealPolicy.restoreRouteCmd("", "192.168.2.1"));
        assertEquals(
                "ndc network route add 102 wlan0 0.0.0.0/0 192.168.2.1",
                HealPolicy.restoreRouteNdcCmd(102, "wlan0", "192.168.2.1"));
        assertEquals("", HealPolicy.restoreRouteNdcCmd(0, "wlan0", "192.168.2.1"));
    }

    @Test
    public void dnsRestoreUsesNumericNetIdNotIface() {
        assertEquals(
                "ndc resolver setnetdns 102 '' 192.168.2.1",
                HealPolicy.restoreDnsCmd(102, "192.168.2.1"));
        assertEquals("", HealPolicy.restoreDnsCmd(0, "192.168.2.1"));
        assertEquals("", HealPolicy.restoreDnsCmd(102, "127.0.0.1"));
        assertEquals("", HealPolicy.restoreDnsCmd(102, "wlan0"));
    }

    @Test
    public void kernelTableOverridesStaleLinkPropertiesDefault() {
        HealPolicy.Facts f = facts();
        f.hasDefaultRoute = true;
        f.gateway = "192.168.2.1";
        HealPolicy.applyKernelTable(f, "192.168.2.0/24 dev wlan0 proto static scope link\n", true);
        assertFalse(f.hasDefaultRoute);
        HealPolicy.applyKernelTable(f,
                "default via 192.168.2.1 dev if28 table 1028\n", true);
        assertTrue(f.hasDefaultRoute);
        assertEquals("192.168.2.1", f.gateway);
    }

    @Test
    public void kernelTableIgnoresInvalidTableNameError() {
        HealPolicy.Facts f = facts();
        f.hasDefaultRoute = true;
        f.gateway = "192.168.2.1";
        HealPolicy.applyKernelTable(f,
                "Error: argument \"wlan0\" is wrong: table id value is invalid\n", true);
        assertTrue(f.hasDefaultRoute);
        assertEquals("192.168.2.1", f.gateway);
    }

    @Test
    public void defaultGatewayFromIfaceTableText() {
        String has = "default via 192.168.2.1 dev wlan0 table wlan0 proto static\n"
                + "192.168.2.0/24 dev wlan0 table wlan0 proto static scope link\n";
        assertEquals("192.168.2.1", HealPolicy.defaultGatewayFromIpRoute(has));
        assertEquals("", HealPolicy.defaultGatewayFromIpRoute(
                "192.168.2.0/24 dev wlan0 proto kernel scope link src 192.168.2.72\n"));
    }

    @Test
    public void parseNetIdFromAndroid8NetworkToString() {
        assertEquals(102, HealPolicy.parseNetId("network{102}"));
        assertEquals(102, HealPolicy.parseNetId("Network { netId=102 }"));
        assertEquals(100, HealPolicy.parseNetId("100"));
        assertEquals(0, HealPolicy.parseNetId("wlan0"));
        assertEquals(0, HealPolicy.parseNetId(""));
    }

    @Test
    public void linkDnsLoopbackMarksBrokenAndClearsDns() {
        HealPolicy.Facts f = facts();
        f.wifiEnabled = true;
        f.hasIpv4 = true;
        f.hasDefaultRoute = true;
        f.dns = "8.8.8.8";
        HealPolicy.applyLinkDns(f, java.util.Arrays.asList("127.0.0.1"));
        assertTrue(f.linkDnsBroken);
        assertEquals("", f.dns);
        HealPolicy.Decision d = HealPolicy.decide(f, snap());
        assertEquals("L5", d.stage);
        assertEquals("restore_dns", d.action);
    }

    @Test
    public void linkDnsUsableKeepsFirstGoodServer() {
        HealPolicy.Facts f = facts();
        HealPolicy.applyLinkDns(f, java.util.Arrays.asList("127.0.0.1", "192.168.2.1"));
        assertFalse(f.linkDnsBroken);
        assertEquals("192.168.2.1", f.dns);
    }

    @Test
    public void emptyLinkDnsListDoesNotMarkBroken() {
        HealPolicy.Facts f = facts();
        HealPolicy.applyLinkDns(f, java.util.Collections.<String>emptyList());
        assertFalse(f.linkDnsBroken);
        assertEquals("", f.dns);
    }

    @Test
    public void wifiToolDhcpRunsAsSystemUid() {
        String cmd = HealPolicy.wifiToolCmd("dhcp", "", "", "");
        assertTrue(cmd.contains("su 1000 -c"));
        assertTrue(cmd.contains("WifiIpTool"));
        assertTrue(cmd.contains("/system/app/ElfRemote/ElfRemote.apk"));
        assertTrue(cmd.contains(" dhcp'"));
        assertFalse(cmd.contains("static"));
    }

    @Test
    public void wifiToolStaticAllowsLoopbackLabDnsAndRejectsInjection() {
        String cmd = HealPolicy.wifiToolCmd("static", "192.168.2.72", "192.168.2.1", "127.0.0.1");
        assertTrue(cmd.contains("static 192.168.2.72 192.168.2.1 127.0.0.1"));
        assertEquals("", HealPolicy.wifiToolCmd("static", "192.168.2.72;rm", "192.168.2.1", "127.0.0.1"));
        assertEquals("", HealPolicy.wifiToolCmd("static", "192.168.2.72", "192.168.2.1", "8.8.8.8;reboot"));
        assertEquals("", HealPolicy.wifiToolCmd("other", "192.168.2.72", "192.168.2.1", "127.0.0.1"));
    }

    private static HealPolicy.Facts facts() {
        HealPolicy.Facts f = new HealPolicy.Facts();
        f.iface = "wlan0";
        f.ssid = "lab";
        return f;
    }

    private static HealPolicy.Snapshot snap() {
        HealPolicy.Snapshot s = new HealPolicy.Snapshot();
        s.iface = "wlan0";
        s.ipv4 = "192.168.1.20";
        s.gateway = "192.168.1.1";
        s.dns = "8.8.8.8";
        s.ssid = "lab";
        return s;
    }
}
