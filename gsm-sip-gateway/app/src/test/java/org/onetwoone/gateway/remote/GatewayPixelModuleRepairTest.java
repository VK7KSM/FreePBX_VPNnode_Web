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

    @Test public void breakerStopsAfterThreeRestoresInADayAndSurvivesRestart() throws Exception {
        File root=modules(),history=new File(temporary.getRoot(),"module-repair.json");
        running.add(new File(root,"pixel_charge_bypass/service.sh").getPath());
        long t=1_800_000_000_000L,step=GatewayPixelModuleRepair.RETRY_MS;
        GatewayPixelModuleRepair repair=new GatewayPixelModuleRepair(root,s->{started.add(s.getParentFile().getName());},running::contains,history);
        for(int i=0;i<3;i++){
            assertTrue(new File(root,"pixel_sip_audio_access/disable").createNewFile());
            assertEquals("restored",repair.check(t+i*step).getString("sip_audio_access"));
        }
        assertTrue(history.isFile());
        // 第 4 次：保持停用，只报一次 tripped，之后安静地 held
        assertTrue(new File(root,"pixel_sip_audio_access/disable").createNewFile());
        assertEquals("tripped",repair.check(t+3*step).getString("sip_audio_access"));
        assertEquals("held",repair.check(t+4*step).getString("sip_audio_access"));
        assertTrue("熔断后不能再去掉停用标记",new File(root,"pixel_sip_audio_access/disable").exists());
        // 模拟开机循环后核心重新启动：记录从文件读回，照样不恢复
        GatewayPixelModuleRepair afterReboot=new GatewayPixelModuleRepair(root,s->{started.add(s.getParentFile().getName());},running::contains,history);
        assertEquals("tripped",afterReboot.check(t+5*step).getString("sip_audio_access"));
        assertTrue(new File(root,"pixel_sip_audio_access/disable").exists());
        assertEquals(3,java.util.Collections.frequency(started,"pixel_sip_audio_access"));
        // 另一个模块不受影响
        assertTrue(new File(root,"pixel_charge_bypass/disable").createNewFile());
        assertEquals("restored",afterReboot.check(t+5*step).getString("charge_bypass"));
        // 第一次恢复满 24 小时后，窗口里只剩 2 次，可以再恢复
        assertEquals("restored",afterReboot.check(t+GatewayPixelModuleRepair.BREAKER_WINDOW_MS+1).getString("sip_audio_access"));
    }

    @Test public void restartingAStoppedChargeLoopDoesNotCountTowardsTheBreaker() throws Exception {
        File root=modules(),history=new File(temporary.getRoot(),"module-repair.json");
        GatewayPixelModuleRepair repair=new GatewayPixelModuleRepair(root,s->{started.add(s.getParentFile().getName());},running::contains,history);
        long t=1_800_000_000_000L;
        for(int i=0;i<5;i++)assertEquals("started",repair.check(t+i*GatewayPixelModuleRepair.RETRY_MS).getString("charge_bypass"));
        assertFalse("只记录去掉停用标记的恢复",history.isFile());
    }

    @Test public void corruptHistoryIsIgnored() throws Exception {
        File root=modules(),history=new File(temporary.getRoot(),"module-repair.json");
        java.nio.file.Files.write(history.toPath(),"{not json".getBytes("UTF-8"));
        running.add(new File(root,"pixel_charge_bypass/service.sh").getPath());
        assertTrue(new File(root,"pixel_sip_audio_access/disable").createNewFile());
        assertEquals("restored",new GatewayPixelModuleRepair(root,s->{},running::contains,history).check(1_000_000L).getString("sip_audio_access"));
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
