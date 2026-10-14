package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.file.Files;
import java.util.*;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/**
 * 2026-10-10 16:17 Magisk 安全模式一次停用了全部模块，限充和通话音频权限失效而网关毫无察觉。
 * 这里验证 root 核心的自检恢复：只恢复认得的两个旧模块，立即执行模块脚本，不碰其它模块，也不反复拉起。
 */
@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayPixelModuleRepairTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    private final List<String> started=new ArrayList<>();
    private final Set<String> running=new HashSet<>();

    private GatewayPixelModuleRepair repair(File root){
        return new GatewayPixelModuleRepair(root,script->{started.add(script.getParentFile().getName());running.add(script.getPath());},running::contains);
    }

    @Test public void bulkDisabledModulesAreRestoredAndAppliedImmediately() throws Exception {
        File root=modules();
        for(String id:new String[]{"pixel_charge_bypass","pixel_sip_audio_access","acc"})assertTrue(new File(root,id+"/disable").createNewFile());
        JSONObject result=repair(root).check(1_000_000L);
        assertEquals("restored",result.getString("charge_bypass"));
        assertEquals("restored",result.getString("sip_audio_access"));
        assertFalse(new File(root,"pixel_charge_bypass/disable").exists());
        assertFalse(new File(root,"pixel_sip_audio_access/disable").exists());
        assertTrue("别的模块不能碰",new File(root,"acc/disable").exists());
        assertEquals(Arrays.asList("pixel_charge_bypass","pixel_sip_audio_access"),started);
        assertTrue(GatewayPixelLegacyHealth.snapshot(root).getBoolean("enabled"));
    }

    @Test public void healthyModulesAreLeftAlone() throws Exception {
        File root=modules();running.add(new File(root,"pixel_charge_bypass/service.sh").getPath());
        JSONObject result=repair(root).check(1_000_000L);
        assertEquals("ok",result.getString("charge_bypass"));
        assertEquals("ok",result.getString("sip_audio_access"));
        assertTrue(started.isEmpty());
    }

    @Test public void enabledChargeLoopThatIsNotRunningIsStartedOnceWithinTheRetryWindow() throws Exception {
        File root=modules();GatewayPixelModuleRepair repair=repair(root);
        assertEquals("started",repair.check(1_000_000L).getString("charge_bypass"));
        running.clear();
        assertEquals("throttled",repair.check(1_000_000L+GatewayPixelModuleRepair.RETRY_MS-1).getString("charge_bypass"));
        assertEquals("started",repair.check(1_000_000L+GatewayPixelModuleRepair.RETRY_MS).getString("charge_bypass"));
        assertEquals(2,Collections.frequency(started,"pixel_charge_bypass"));
        assertFalse("音频脚本做完就退出，没被停用就不重复执行",started.contains("pixel_sip_audio_access"));
    }

    @Test public void disabledChargeModuleWithItsLoopStillRunningIsNotStartedTwice() throws Exception {
        File root=modules();running.add(new File(root,"pixel_charge_bypass/service.sh").getPath());
        assertTrue(new File(root,"pixel_charge_bypass/disable").createNewFile());
        assertEquals("restored",repair(root).check(1_000_000L).getString("charge_bypass"));
        assertFalse(started.contains("pixel_charge_bypass"));
    }

    @Test public void unrecognizedOrRemovingModulesAreNeverTouched() throws Exception {
        File root=modules();
        assertTrue(new File(root,"pixel_charge_bypass/disable").createNewFile());
        Files.write(new File(root,"pixel_charge_bypass/service.sh").toPath(),"changed\n".getBytes("UTF-8"));
        assertTrue(new File(root,"pixel_sip_audio_access/disable").createNewFile());
        assertTrue(new File(root,"pixel_sip_audio_access/remove").createNewFile());
        JSONObject result=repair(root).check(1_000_000L);
        assertEquals("unrecognized",result.getString("charge_bypass"));
        assertEquals("removing",result.getString("sip_audio_access"));
        assertTrue(new File(root,"pixel_charge_bypass/disable").exists());
        assertTrue(new File(root,"pixel_sip_audio_access/disable").exists());
        assertTrue(started.isEmpty());
    }

    @Test public void launcherFailureIsReportedAndRetriedLater() throws Exception {
        File root=modules();assertTrue(new File(root,"pixel_sip_audio_access/disable").createNewFile());
        running.add(new File(root,"pixel_charge_bypass/service.sh").getPath());
        GatewayPixelModuleRepair failing=new GatewayPixelModuleRepair(root,script->{throw new IOException("no busybox");},running::contains);
        assertEquals("failed",failing.check(1_000_000L).getString("sip_audio_access"));
        assertFalse("标记已去掉，重启后照样加载",new File(root,"pixel_sip_audio_access/disable").exists());
        assertEquals("throttled",failing.check(1_000_001L).getString("sip_audio_access"));
        // 标记虽已去掉，启动失败的模块到点仍要重试立即生效
        GatewayPixelModuleRepair same=failing;
        assertEquals("failed",same.check(1_000_000L+GatewayPixelModuleRepair.RETRY_MS).getString("sip_audio_access"));
    }

    @Test public void failedLaunchIsRetriedUntilItSucceeds() throws Exception {
        File root=modules();assertTrue(new File(root,"pixel_sip_audio_access/disable").createNewFile());
        running.add(new File(root,"pixel_charge_bypass/service.sh").getPath());
        boolean[] broken={true};
        GatewayPixelModuleRepair repair=new GatewayPixelModuleRepair(root,script->{if(broken[0])throw new IOException("busy");started.add(script.getParentFile().getName());},running::contains);
        assertEquals("failed",repair.check(1_000_000L).getString("sip_audio_access"));
        broken[0]=false;
        assertEquals("started",repair.check(1_000_000L+GatewayPixelModuleRepair.RETRY_MS).getString("sip_audio_access"));
        assertEquals("ok",repair.check(1_000_000L+2*GatewayPixelModuleRepair.RETRY_MS).getString("sip_audio_access"));
        assertEquals(Collections.singletonList("pixel_sip_audio_access"),started);
    }

    /** 每次「开机」换一个 boot_id；同一实例模拟同一次开机内的多次检查，新实例模拟核心重启。 */
    private final String[] boot = {"aaaaaaaa-0000-0000-0000-000000000001"};
    private int bootSeq = 1;
    private void reboot() { boot[0] = String.format("aaaaaaaa-0000-0000-0000-%012d", ++bootSeq); }
    private GatewayPixelModuleRepair repairAt(File root, File history) {
        return new GatewayPixelModuleRepair(root, s -> started.add(s.getParentFile().getName()), running::contains, history, () -> boot[0]);
    }
    private String disableAndCheck(File root, File history, long now) throws Exception {
        assertTrue(new File(root, "pixel_sip_audio_access/disable").createNewFile());
        return repairAt(root, history).check(now).getString("sip_audio_access");
    }

    @Test public void breakerHoldsAfterThreeConsecutiveBootsNeededRestore() throws Exception {
        File root = modules(), history = new File(temporary.getRoot(), "module-repair.json");
        running.add(new File(root, "pixel_charge_bypass/service.sh").getPath());
        // 第 1、2、3 次开机都被安全模式停用，都恢复
        for (int i = 0; i < 3; i++) {
            assertEquals("restored", disableAndCheck(root, history, 1_000_000L));
            reboot();
        }
        // 第 4 次开机：前面连续 3 次都恢复过，保持停用，只报一次 tripped
        assertTrue(new File(root, "pixel_sip_audio_access/disable").createNewFile());
        GatewayPixelModuleRepair fourth = repairAt(root, history);
        assertEquals("tripped", fourth.check(1_000_000L).getString("sip_audio_access"));
        assertEquals("held", fourth.check(1_000_000L + GatewayPixelModuleRepair.RETRY_MS).getString("sip_audio_access"));
        assertTrue("熔断后不能再去掉停用标记", new File(root, "pixel_sip_audio_access/disable").exists());
        assertEquals(3, java.util.Collections.frequency(started, "pixel_sip_audio_access"));
        // 再开机一次（第 5 次）仍然保持停用：被留住的那次开机没有恢复，但它之前的连续 3 次还在
        reboot();
        assertEquals("tripped", repairAt(root, history).check(1_000_000L).getString("sip_audio_access"));
        // 另一个模块不受影响
        assertTrue(new File(root, "pixel_charge_bypass/disable").createNewFile());
        assertEquals("restored", repairAt(root, history).check(1_000_000L).getString("charge_bypass"));
    }

    @Test public void aNormalBootInBetweenResetsTheCount() throws Exception {
        File root = modules(), history = new File(temporary.getRoot(), "module-repair.json");
        running.add(new File(root, "pixel_charge_bypass/service.sh").getPath());
        assertEquals("restored", disableAndCheck(root, history, 1_000_000L)); reboot();
        assertEquals("restored", disableAndCheck(root, history, 1_000_000L)); reboot();
        // 这次开机模块正常，没有恢复
        assertEquals("ok", repairAt(root, history).check(1_000_000L).getString("sip_audio_access")); reboot();
        assertEquals("restored", disableAndCheck(root, history, 1_000_000L)); reboot();
        assertEquals("restored", disableAndCheck(root, history, 1_000_000L)); reboot();
        assertEquals("连续计数只有 2，照常恢复", "restored", disableAndCheck(root, history, 1_000_000L));
    }

    @Test public void severalRestoresWithinOneBootCountOnce() throws Exception {
        File root = modules(), history = new File(temporary.getRoot(), "module-repair.json");
        running.add(new File(root, "pixel_charge_bypass/service.sh").getPath());
        GatewayPixelModuleRepair sameBoot = repairAt(root, history);
        for (int i = 0; i < 5; i++) {
            assertTrue(new File(root, "pixel_sip_audio_access/disable").createNewFile());
            assertEquals("restored", sameBoot.check(1_000_000L + i * GatewayPixelModuleRepair.RETRY_MS).getString("sip_audio_access"));
        }
        reboot();
        assertEquals("同一次开机只算一次", "restored", disableAndCheck(root, history, 1_000_000L));
    }

    @Test public void clockGoingBackwardsDoesNotDisableTheBreaker() throws Exception {
        File root = modules(), history = new File(temporary.getRoot(), "module-repair.json");
        running.add(new File(root, "pixel_charge_bypass/service.sh").getPath());
        long[] clock = {1_800_000_000_000L, 1_800_000_100_000L, 1_000L};   // 第三次开机时钟回到 1970
        for (long now : clock) { assertEquals("restored", disableAndCheck(root, history, now)); reboot(); }
        assertTrue(new File(root, "pixel_sip_audio_access/disable").createNewFile());
        assertEquals("tripped", repairAt(root, history).check(5_000L).getString("sip_audio_access"));
    }

    @Test public void restartingAStoppedChargeLoopDoesNotCountTowardsTheBreaker() throws Exception {
        File root = modules(), history = new File(temporary.getRoot(), "module-repair.json");
        for (int i = 0; i < 5; i++) {
            assertEquals("started", repairAt(root, history).check(1_000_000L).getString("charge_bypass"));
            running.clear(); reboot();
        }
        assertTrue(new File(root, "pixel_charge_bypass/disable").createNewFile());
        assertEquals("拉起脚本不计数", "restored", repairAt(root, history).check(1_000_000L).getString("charge_bypass"));
    }

    @Test public void corruptOrOldFormatHistoryIsIgnored() throws Exception {
        File root = modules(), history = new File(temporary.getRoot(), "module-repair.json");
        running.add(new File(root, "pixel_charge_bypass/service.sh").getPath());
        java.nio.file.Files.write(history.toPath(), "{not json".getBytes("UTF-8"));
        assertEquals("restored", disableAndCheck(root, history, 1_000_000L));
        // 82 版按时间戳存的旧格式
        java.nio.file.Files.write(history.toPath(), "{\"pixel_sip_audio_access\":[1,2,3,4]}".getBytes("UTF-8"));
        reboot();
        assertEquals("restored", disableAndCheck(root, history, 1_000_000L));
    }

    @Test public void unreadableBootIdNeverBlocksARestore() throws Exception {
        File root = modules(), history = new File(temporary.getRoot(), "module-repair.json");
        running.add(new File(root, "pixel_charge_bypass/service.sh").getPath());
        for (int i = 0; i < 5; i++) {
            assertTrue(new File(root, "pixel_sip_audio_access/disable").createNewFile());
            GatewayPixelModuleRepair r = new GatewayPixelModuleRepair(root, s -> {}, running::contains, history, () -> { throw new java.io.IOException("no proc"); });
            assertEquals("restored", r.check(1_000_000L).getString("sip_audio_access"));
        }
    }

    @Test public void scriptScanMatchesWholeArgumentsOnly() {
        assertFalse(GatewayPixelModuleRepair.scriptRunning("/data/adb/modules/pixel_charge_bypass/service.sh-no-such"));
    }

    /** 两个旧模块按 APK 里冻结的文件建好（哈希与 GatewayPixelLegacyHealth 的期望一致），另放一个无关的 acc。 */
    private File modules() throws Exception {
        File root=temporary.newFolder();
        copy(fixture("pixel_charge_bypass"),new File(root,"pixel_charge_bypass"));
        copy(fixture("pixel_sip_audio_access"),new File(root,"pixel_sip_audio_access"));
        File acc=new File(root,"acc");assertTrue(acc.mkdir());
        Files.write(new File(acc,"module.prop").toPath(),"id=acc\n".getBytes("UTF-8"));
        return root;
    }
    private static void copy(File source,File target) throws Exception {
        assertTrue(target.mkdir());File[] files=source.listFiles(File::isFile);assertNotNull(files);
        for(File file:files)Files.copy(file.toPath(),new File(target,file.getName()).toPath());
    }
    private static File fixture(String id) throws Exception {
        File current=new File(System.getProperty("user.dir")).getCanonicalFile();
        for(int depth=0;depth<6&&current!=null;depth++,current=current.getParentFile()) {
            File candidate=new File(current,"app/src/main/assets/pixel_gateway_companion/legacy/"+id);
            if(candidate.isDirectory())return candidate;
            candidate=new File(current,"src/main/assets/pixel_gateway_companion/legacy/"+id);
            if(candidate.isDirectory())return candidate;
        }
        throw new FileNotFoundException(id);
    }
}
