package net.elfradio.elfremote;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class WatchdogPolicyTest {
    @Test
    public void taskDirectoryIsLimitedToRootAndApplicationGroup() {
        String script=WatchdogPolicy.script();
        assertFalse(script.contains("0777"));
        assertFalse(script.contains("0666"));
        assertTrue(script.contains("chmod 2770"));
        assertTrue(script.contains("umask 007"));
        assertTrue(script.contains("[ ! -L \"$DIR\" ] || exit 1"));
        assertTrue(WatchdogPolicy.LOG.startsWith(WatchdogPolicy.DIR+"/"));
        assertTrue(WatchdogPolicy.applyCommands("/tmp/staged").contains(WatchdogPolicy.secureDirectoryCommands()));
    }

    @Test
    public void scriptNeverTouchesD22CodexOrTalkApps() {
        String script = WatchdogPolicy.script();
        assertIndependent(script);
        assertTrue(script.contains("net.elfradio.elfremote/.ReportService"));
        assertTrue(script.contains("start-foreground-service"));
        assertTrue(script.contains("export PATH=/system/bin"));
        assertFalse(script.contains("awk"));
        assertFalse(script.contains("MainActivity"));
        assertFalse(script.contains("am start "));
        assertFalse(script.contains("am start\t"));
        assertTrue(script.contains("skip duplicate start"));
        assertTrue(script.contains("sys.boot_completed"));
        assertFalse(script.contains("/proc/[0-9]*/cmdline"));
        assertTrue(script.contains("SLEEP=" + WatchdogPolicy.SLEEP_SEC));
        assertTrue(script.contains("run_heal"));
        assertTrue(script.contains("heal.rc.tmp"));
        assertTrue(script.contains("run_update"));
        assertTrue(script.contains("update.job"));
        assertTrue(script.contains("sleep 1"));
        assertTrue(script.contains("updater.apk"));
        assertTrue(script.contains("mv \"$DIR/update.running\" \"$DIR/update.job\""));
        assertTrue(WatchdogPolicy.SLEEP_SEC >= 15);
    }

    @Test
    public void lockCleanupDoesNotDropSuccessorLock() {
        String script = WatchdogPolicy.script();
        assertTrue(script.contains("cur=$(cat \"$PIDF\""));
        assertTrue(script.contains("[ \"$cur\" = \"$$\" ]"));
        assertFalse(script.contains("trap 'rm -rf \"$LOCK\"' EXIT"));
    }

    @Test
    public void applyCommandsSkipWorkWhenUnchangedAndAlive() {
        String cmd = WatchdogPolicy.applyCommands("/tmp/staged");
        assertTrue(cmd.contains("cmp -s"));
        assertTrue(cmd.contains("alive=1"));
        assertTrue(cmd.contains("need_init=0"));
    }

    @Test
    public void quietKeepaliveChannelIsNotTheOldDefault() {
        assertEquals("elfremote-quiet", WatchdogPolicy.NOTIFY_CHANNEL);
        assertFalse("elfremote".equals(WatchdogPolicy.NOTIFY_CHANNEL));
        assertFalse(WatchdogPolicy.notificationLaunchesUi());
    }

    @Test
    public void initRcIsOwnServiceNotCodex() {
        String rc = WatchdogPolicy.initRc();
        assertIndependent(rc);
        assertTrue(rc.contains("service elfremote_wd "));
        assertTrue(rc.contains("oneshot"));
        assertFalse(rc.contains("codex_zello_kiosk"));
        assertFalse(rc.contains("start codex_"));
        assertEquals("/system/etc/init/elfremote.rc", WatchdogPolicy.INIT_RC_PATH);
    }

    @Test
    public void magiskWrapperOnlyExecsElfRemoteScript() {
        String w = WatchdogPolicy.magiskWrapper();
        assertIndependent(w);
        assertTrue(w.contains("exec"));
        assertTrue(w.contains(WatchdogPolicy.SCRIPT_PATH));
        assertEquals("/data/adb/service.d/elfremote_watchdog.sh", WatchdogPolicy.MAGISK_WRAPPER_PATH);
    }

    @Test
    public void applyCommandsNeverEditCodexPaths() {
        String cmd = WatchdogPolicy.applyCommands("/tmp/staged");
        assertIndependent(cmd);
        assertFalse(cmd.contains("/system/etc/codex"));
        assertFalse(cmd.contains("codex_d22.rc"));
        assertTrue(cmd.contains(WatchdogPolicy.SCRIPT_PATH));
        assertTrue(cmd.contains(WatchdogPolicy.MAGISK_WRAPPER_PATH));
        assertTrue(cmd.contains(WatchdogPolicy.INIT_RC_PATH));
    }

    @Test
    public void resourceBudgetKeepsIdleCostLow() {
        assertTrue(WatchdogPolicy.SLEEP_SEC >= 15);
        assertTrue(WatchdogPolicy.STATS_EVERY_LOOPS >= 12);
        assertTrue(WatchdogPolicy.LOG_MAX_BYTES <= 32 * 1024);
        assertTrue(WatchdogPolicy.WD_RSS_KB_MAX <= 4096);
        assertTrue(WatchdogPolicy.APP_RSS_KB_MAX <= 64 * 1024);
        assertTrue(WatchdogPolicy.pairedReportIntervalMs() >= 45_000L);
        assertTrue(WatchdogPolicy.unpairedReportIntervalMs() >= 8_000L);
        assertTrue(WatchdogPolicy.unpairedReportIntervalMs() <= 15_000L);
    }

    @Test
    public void hostWatchdogCopiesMatchPolicy() throws Exception {
        assertEquals(WatchdogPolicy.script(), read(repoFile("watchdog.sh")));
        assertEquals(WatchdogPolicy.initRc(), read(repoFile("elfremote.rc")));
        assertEquals(WatchdogPolicy.magiskWrapper(), read(repoFile("magisk.sh")));
    }

    @Test
    public void stageWritesThreeIndependentFiles() throws Exception {
        File dir = Files.createTempDirectory("elfremote-wd").toFile();
        WatchdogPolicy.stage(dir);
        String script = read(new File(dir, "watchdog.sh"));
        String rc = read(new File(dir, "elfremote.rc"));
        String magisk = read(new File(dir, "magisk.sh"));
        assertEquals(WatchdogPolicy.script(), script);
        assertEquals(WatchdogPolicy.initRc(), rc);
        assertEquals(WatchdogPolicy.magiskWrapper(), magisk);
        assertIndependent(script + rc + magisk);
    }

    private static File repoFile(String name) {
        File[] candidates = new File[] {
                new File("tools/watchdog/" + name),
                new File("../tools/watchdog/" + name),
                new File("elfRemote/tools/watchdog/" + name)
        };
        for (int i = 0; i < candidates.length; i++) {
            if (candidates[i].isFile()) return candidates[i];
        }
        throw new AssertionError("missing tools/watchdog/" + name);
    }

    private static String read(File f) throws Exception {
        String raw = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        return raw.replace("\r\n", "\n");
    }

    private static void assertIndependent(String text) {
        String s = text.toLowerCase();
        assertFalse(s.contains("loudtalks"));
        assertFalse(s.contains("zello"));
        assertFalse(s.contains("linphone"));
        assertFalse(s.contains("codex_zello"));
        assertFalse(s.contains("codex_call"));
        assertFalse(s.contains("codex_wake"));
        assertFalse(s.contains("codex_firewall"));
        assertFalse(s.contains("dumpsys"));
        assertFalse(s.contains("uiautomator"));
        assertFalse(s.contains("input keyevent"));
    }
}
