package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;

import java.security.MessageDigest;
import java.util.LinkedHashMap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class RepairPolicyTest {
    @Test
    public void thisSliceAllowsPullLogsHealAndReboot() {
        assertTrue(RepairPolicy.allowedType("pull_logs"));
        assertTrue(RepairPolicy.allowedType("heal_network"));
        assertTrue(RepairPolicy.allowedType("reboot"));
        assertTrue(RepairPolicy.allowedType("install_apk"));
        assertTrue(RepairPolicy.allowedType("restart_adbd"));
        assertFalse(RepairPolicy.allowedType("shell"));
        assertFalse(RepairPolicy.allowedType(""));
        assertFalse(RepairPolicy.allowedType(null));
    }

    @Test
    public void offerRequiresIdTypeExpiryAndIdempotencyKey() throws Exception {
        JSONObject good = offer("t1", "pull_logs", 5000L, "k1");
        assertEquals("", RepairPolicy.rejectReason(good, 1000L));
        assertEquals("t1", RepairPolicy.parseOffer(good, 1000L).getString("id"));
        assertEquals("missing-id", RepairPolicy.rejectReason(offer("", "pull_logs", 5000L, "k1"), 1000L));
        assertEquals("missing-key", RepairPolicy.rejectReason(offer("t1", "pull_logs", 5000L, ""), 1000L));
        assertEquals("", RepairPolicy.rejectReason(offer("t1", "heal_network", 5000L, "k1"), 1000L));
        assertEquals("", RepairPolicy.rejectReason(offer("t1", "reboot", 5000L, "k1"), 1000L));
        assertEquals("", RepairPolicy.rejectReason(offer("t1", "install_apk", 5000L, "k1"), 1000L));
        assertEquals("unknown-type", RepairPolicy.rejectReason(offer("t1", "shell", 5000L, "k1"), 1000L));
        assertEquals("expired", RepairPolicy.rejectReason(offer("t1", "pull_logs", 1000L, "k1"), 1000L));
        assertNull(RepairPolicy.parseOffer(offer("t1", "shell", 5000L, "k1"), 1000L));
    }

    @Test
    public void sameTaskIdIsIdempotent() {
        assertTrue(RepairPolicy.alreadyDone("t1", "t1"));
        assertFalse(RepairPolicy.alreadyDone("", "t1"));
        assertFalse(RepairPolicy.alreadyDone("t1", "t2"));
        assertFalse(RepairPolicy.alreadyDone(null, "t1"));
        assertTrue(RepairPolicy.alreadyDone("t1", "", "t1"));
        assertTrue(RepairPolicy.alreadyDone("t1", RepairPolicy.PHASE_DONE, "t1"));
        assertFalse(RepairPolicy.alreadyDone("t1", RepairPolicy.PHASE_RUNNING, "t1"));
    }

    @Test
    public void rebootRunningMustConfirmNotRepeat() {
        assertTrue(RepairPolicy.shouldConfirmReboot("t1", RepairPolicy.PHASE_RUNNING, "t1"));
        assertFalse(RepairPolicy.shouldConfirmReboot("t1", RepairPolicy.PHASE_DONE, "t1"));
        assertFalse(RepairPolicy.shouldConfirmReboot("t1", RepairPolicy.PHASE_RUNNING, "t2"));
        assertFalse(RepairPolicy.shouldConfirmReboot("", RepairPolicy.PHASE_RUNNING, "t1"));
        assertTrue(RepairPolicy.shouldConfirmReboot("t1", RepairPolicy.PHASE_RUNNING, "t1", "boot-a", "boot-b"));
        assertFalse(RepairPolicy.shouldConfirmReboot("t1", RepairPolicy.PHASE_RUNNING, "t1", "boot-a", "boot-a"));
        assertFalse(RepairPolicy.shouldConfirmReboot("t1", RepairPolicy.PHASE_RUNNING, "t1", "", "boot-b"));
        assertEquals("reboot", RepairPolicy.rebootCommand());
    }

    @Test
    public void installParamsRequireHttpsHashAndPackage() throws Exception {
        JSONObject p = new JSONObject();
        p.put("package", "net.elfradio.elfremote");
        p.put("versionCode", 44);
        p.put("versionName", "0.1.43-d22xx-instala");
        p.put("sha256", "ab".repeat(32));
        p.put("size", 12);
        p.put("url", "https://v.elfradio.net/api/elfremote/apk/job1");
        assertTrue(RepairPolicy.parseInstallParams(p) != null);
        p.put("url", "http://127.0.0.1/x.apk");
        assertEquals(null, RepairPolicy.parseInstallParams(p));
    }

    @Test
    public void installConfirmsOnlyAfterTargetVersionAndInstallingPhase() {
        assertTrue(RepairPolicy.shouldConfirmInstall(
                "t1", RepairPolicy.PHASE_INSTALLING, "t1",
                "0.1.43-d22xx-instala", "0.1.43-d22xx-instala"));
        assertFalse(RepairPolicy.shouldConfirmInstall(
                "t1", RepairPolicy.PHASE_INSTALLING, "t1",
                "0.1.42-d22xx-reboot", "0.1.43-d22xx-instala"));
        assertFalse(RepairPolicy.shouldConfirmInstall(
                "t1", RepairPolicy.PHASE_RUNNING, "t1",
                "0.1.43-d22xx-instala", "0.1.43-d22xx-instala"));
        assertTrue(RepairPolicy.alreadyOnTarget("0.1.43-d22xx-instala", "0.1.43-d22xx-instala"));
        assertFalse(RepairPolicy.alreadyOnTarget("0.1.42-d22xx-reboot", "0.1.43-d22xx-instala"));
        assertTrue(RepairPolicy.installCommand().contains("/system/app/ElfRemote/ElfRemote.apk"));
        assertTrue(RepairPolicy.installCommand().contains("reboot"));
    }

    @Test
    public void restartAdbdBindsLoopbackAndDoesNotPersistLanPort() {
        String cmd = RepairPolicy.adbdCommand();
        assertTrue(cmd.contains("service.adb.tcp.port"));
        assertTrue(cmd.contains("5555"));
        assertTrue(cmd.contains("lo"));
        assertFalse(cmd.contains("persist.adb.tcp.port"));
        assertTrue(cmd.indexOf("rule ip6tables") < cmd.indexOf("setprop service.adb.tcp.port 5555"));
        assertTrue(cmd.contains("trap restore EXIT"));
        assertEquals("重启本机adbd", RepairPolicy.typeLabel("restart_adbd"));
    }

    @Test public void adbdSuccessRequiresExitCodeAndCompleteVerificationMarker() {
        assertTrue(RepairPolicy.adbdSucceeded("0", "tcp listen\nADBD_LOOPBACK_OK\n"));
        assertFalse(RepairPolicy.adbdSucceeded("1", "ADBD_LOOPBACK_OK\n"));
        assertFalse(RepairPolicy.adbdSucceeded("0", "PORT=5555\n"));
        assertFalse(RepairPolicy.adbdSucceeded("0", "echo ADBD_LOOPBACK_OK\n"));
        assertFalse(RepairPolicy.adbdSucceeded("", null));
    }

    @Test
    public void packLogsHashesUtf8BytesAndTruncates() throws Exception {
        LinkedHashMap<String, String> files = new LinkedHashMap<String, String>();
        files.put("watchdog.log", "wd-ok");
        RepairPolicy.Pack p = RepairPolicy.packLogs(files, "logcat-line", "0.1.39-d22xx-taska");
        assertFalse(p.truncated);
        assertEquals(64, p.sha256.length());
        assertEquals(p.sha256, sha256Hex(p.text.getBytes("UTF-8")));
        assertTrue(p.text.contains("app_version=0.1.39-d22xx-taska"));
        assertTrue(p.text.contains("== watchdog.log =="));
        assertTrue(p.text.contains("wd-ok"));
        assertTrue(p.text.contains("== logcat =="));
        assertTrue(p.size > 0);
        assertEquals(p.size, p.text.getBytes("UTF-8").length);
    }

    @Test
    public void packLogsTruncatesToLimitAndStillHasHash() throws Exception {
        StringBuilder big = new StringBuilder();
        while (big.length() < RepairPolicy.MAX_LOG_BYTES + 200) big.append("x");
        LinkedHashMap<String, String> files = new LinkedHashMap<String, String>();
        files.put("heal.log", big.toString());
        RepairPolicy.Pack p = RepairPolicy.packLogs(files, "", "0.1.39");
        assertTrue(p.truncated);
        assertEquals(RepairPolicy.MAX_LOG_BYTES, p.size);
        assertEquals(64, p.sha256.length());
        assertEquals(p.sha256, sha256Hex(p.text.getBytes("UTF-8")));
    }

    @Test
    public void emptySourcesStillProduceResultBytes() throws Exception {
        RepairPolicy.Pack p = RepairPolicy.packLogs(null, "", "0.1.39");
        assertFalse(p.truncated);
        assertTrue(p.size > 0);
        assertTrue(p.text.startsWith("app_version=0.1.39"));
        assertEquals(64, p.sha256.length());
    }

    @Test
    public void chineseLabelsForThisSlice() {
        assertEquals("拉取日志", RepairPolicy.typeLabel("pull_logs"));
        assertEquals("强制自愈", RepairPolicy.typeLabel("heal_network"));
        assertEquals("受控重启", RepairPolicy.typeLabel("reboot"));
        assertEquals("覆盖安装", RepairPolicy.typeLabel("install_apk"));
        assertEquals("重启本机adbd", RepairPolicy.typeLabel("restart_adbd"));
        assertEquals("", RepairPolicy.typeLabel("shell"));
        assertEquals("待领取", RepairPolicy.stateLabel("pending"));
        assertEquals("已领取", RepairPolicy.stateLabel("claimed"));
        assertEquals("执行中", RepairPolicy.stateLabel("running"));
        assertEquals("成功", RepairPolicy.stateLabel("success"));
        assertEquals("失败", RepairPolicy.stateLabel("failed"));
        assertEquals("已过期", RepairPolicy.stateLabel("expired"));
        assertEquals("已拒绝", RepairPolicy.stateLabel("rejected"));
        assertEquals("", RepairPolicy.stateLabel("bogus"));
    }

    private static JSONObject offer(String id, String type, long exp, String key) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("type", type);
        o.put("expires_at", exp);
        o.put("idempotency_key", key);
        o.put("params", new JSONObject());
        return o;
    }

    private static String sha256Hex(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.length; i++) sb.append(String.format("%02x", d[i] & 0xff));
        return sb.toString();
    }
}
