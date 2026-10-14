package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

/**
 * Pixel 旧模块（限充、通话音频权限）被停用后的自检恢复，由 root 核心每分钟执行一次。
 *
 * <p>2026-10-10 16:17 起因：电池耗尽前后的一次开机里，Magisk 进入安全模式，把全部模块一次停用。
 * 限充脚本从此不再运行，手机一直充到 100%；音频节点也回到系统默认权限，网关转接的电话没有声音。
 * 网关本身毫无察觉，直到所有者发现电量异常。
 *
 * <p>这里只处理这两个旧模块，并且只在模块文件与冻结哈希一致（{@link GatewayPixelLegacyHealth} 认得）时才动手；
 * 带 remove 标记（Magisk 准备卸载）的不处理；acc 等其它模块一律不碰。恢复时先去掉 disable 标记，
 * 再用与 Magisk 启动模块完全相同的方式执行模块自带的脚本，立即生效，不必重启。
 * 同一模块 10 分钟内最多尝试一次，避免反复拉起。
 *
 * <p>熔断（web-dev 评审建议，2026-10-14 加入）：Magisk 安全模式本来是救开机循环用的。万一将来真是某个模块
 * 让手机开不了机，每次开机都被我们重新启用就会一直循环。所以按开机次数计：紧挨着本次之前，已有连续 3 次开机
 * 都发现同一模块被停用，本次就不再恢复，保持停用、只记一次日志。熔断后模块一直停着，之后每次开机也都算「被停用」，
 * 所以熔断会一直保持，直到有人手动重新启用、出现一次正常开机为止；中间只要有一次开机模块是正常启用的，计数就清零。
 * 同一次开机里多次被停用只算一次（同次开机内仍由 10 分钟节流限制）。开机由内核 boot_id 区分，与时钟无关：电池耗尽后 RTC 丢失、
 * 时间回到很早也不受影响（第一版按 24 小时墙钟计算，有这个漏洞）。记录写在核心目录的文件里，开机后仍然有效；
 * 只计「去掉停用标记」，不计「拉起没在跑的限充脚本」。
 */
final class GatewayPixelModuleRepair {
    static final long RETRY_MS=10*60_000L;
    static final int BREAKER_MAX=3;
    static final int BOOTS_KEPT=16;
    static final String BUSYBOX="/data/adb/magisk/busybox";

    interface Launcher { void start(File script) throws Exception; }
    interface Processes { boolean running(String scriptPath) throws Exception; }
    interface BootId { String current() throws Exception; }

    private final File root;private final Launcher launcher;private final Processes processes;
    private final Map<String,Long> lastAttempt=new HashMap<>();
    /** 去掉了停用标记、但脚本没能启动的模块：标记已去掉，下次重启自然会加载，在那之前仍按间隔重试立即生效。 */
    private final java.util.Set<String> pending=new java.util.HashSet<>();
    /** 恢复记录文件（null 时只记在内存里，仅供测试）。 */
    private final File history;
    private final BootId bootId;
    /** 核心见过的开机（boot_id），按先后顺序，最多保留 BOOTS_KEPT 次。 */
    private final java.util.List<String> boots=new java.util.ArrayList<>();
    /** 每个模块：在哪几次开机里被发现停用（恢复了或因熔断留着都算）。 */
    private final Map<String,java.util.Set<String>> restoredIn=new HashMap<>();
    private final java.util.Set<String> tripped=new java.util.HashSet<>();

    GatewayPixelModuleRepair(File root,Launcher launcher,Processes processes){this(root,launcher,processes,null,()->"00000000-test-boot");}
    GatewayPixelModuleRepair(File root,Launcher launcher,Processes processes,File history,BootId bootId){
        this.root=root;this.launcher=launcher;this.processes=processes;this.history=history;this.bootId=bootId;loadHistory();
    }

    static GatewayPixelModuleRepair system(){
        return new GatewayPixelModuleRepair(new File("/data/adb/modules"),GatewayPixelModuleRepair::launch,GatewayPixelModuleRepair::scriptRunning,
                new File(GatewayCoreClient.DIR,"module-repair.json"),GatewayPixelModuleRepair::readBootId);
    }

    /** 返回每个模块本次的处理结果：ok、restored、started、throttled、unrecognized、removing、failed，
     *  以及熔断的 tripped（刚熔断，记一次日志）和 held（熔断中，不再记日志）。 */
    synchronized JSONObject check(long now) throws Exception {
        String boot=currentBoot();
        JSONObject snapshot=GatewayPixelLegacyHealth.snapshot(root);
        return new JSONObject()
                .put("charge_bypass",repair(snapshot.getJSONObject("charge_bypass"),true,now,boot))
                .put("sip_audio_access",repair(snapshot.getJSONObject("sip_audio_access"),false,now,boot));
    }

    private String repair(JSONObject module,boolean keepsRunning,long now,String boot) {
        if(!module.optBoolean("recognized"))return "unrecognized";
        String id=module.optString("id");File directory=new File(root,id),script=new File(directory,"service.sh");
        if(new File(directory,"remove").exists())return "removing";
        boolean disabled=module.optBoolean("disabled");
        if(disabled)markDisabledIn(id,boot);
        if(disabled&&boot!=null&&consecutiveBootsRestored(id,boot)>=BREAKER_MAX)return tripped.add(id)?"tripped":"held";
        tripped.remove(id);
        try {
            // 限充脚本是常驻循环：模块启用着却没在跑（被杀、开机没拉起）也要补上。音频脚本做完就退出，只在恢复时执行。
            boolean missing=keepsRunning&&!disabled&&!processes.running(script.getPath());
            if(!disabled&&!missing&&!pending.contains(id))return "ok";
            Long last=lastAttempt.get(id);
            if(last!=null&&now-last<RETRY_MS)return "throttled";
            lastAttempt.put(id,now);
            if(disabled) {
                File flag=new File(directory,"disable");
                if(!flag.delete()&&flag.exists())return "failed";
            }
            pending.add(id);
            if(!keepsRunning||!processes.running(script.getPath()))launcher.start(script);
            pending.remove(id);
            return disabled?"restored":"started";
        } catch(Exception failure) {
            return "failed";
        }
    }

    /** 本次开机的 boot_id；第一次见到时追加到开机序列并保存。读不到时返回 null（不熔断，照常恢复）。 */
    private String currentBoot(){
        String boot;
        try{boot=bootId.current();}catch(Exception e){return null;}
        if(boot==null||!boot.matches("[0-9a-zA-Z-]{8,64}"))return null;
        if(boots.isEmpty()||!boots.get(boots.size()-1).equals(boot)){
            boots.remove(boot);boots.add(boot);
            while(boots.size()>BOOTS_KEPT){
                String old=boots.remove(0);
                for(java.util.Set<String> set:restoredIn.values())set.remove(old);
            }
            saveHistory();
        }
        return boot;
    }

    /** 紧挨着本次开机之前，连续有几次开机都发现这个模块被停用（本次不算）。 */
    private int consecutiveBootsRestored(String id,String boot){
        java.util.Set<String> set=restoredIn.get(id);if(set==null)return 0;
        int count=0;
        for(int i=boots.size()-1;i>=0;i--){
            String b=boots.get(i);
            if(b.equals(boot))continue;
            if(!set.contains(b))break;
            count++;
        }
        return count;
    }

    private void markDisabledIn(String id,String boot){
        if(boot==null)return;
        if(restoredIn.computeIfAbsent(id,k->new java.util.HashSet<>()).add(boot))saveHistory();
    }

    /** 格式：{"boots":[...],"restored":{"模块":[boot_id,...]}}；第一版按时间戳存的旧格式直接忽略。 */
    private void loadHistory(){
        if(history==null||!history.isFile()||history.length()>65536)return;
        try{
            JSONObject json=new JSONObject(new String(java.nio.file.Files.readAllBytes(history.toPath()),java.nio.charset.StandardCharsets.UTF_8));
            org.json.JSONArray list=json.optJSONArray("boots");JSONObject restored=json.optJSONObject("restored");
            if(list==null||restored==null)return;
            for(int i=Math.max(0,list.length()-BOOTS_KEPT);i<list.length();i++)boots.add(list.getString(i));
            for(java.util.Iterator<String> it=restored.keys();it.hasNext();){
                String id=it.next();org.json.JSONArray arr=restored.optJSONArray(id);if(arr==null)continue;
                java.util.Set<String> set=new java.util.HashSet<>();
                for(int i=0;i<arr.length();i++)if(boots.contains(arr.getString(i)))set.add(arr.getString(i));
                restoredIn.put(id,set);
            }
        }catch(Exception ignored){boots.clear();restoredIn.clear();}
    }

    private void saveHistory(){
        if(history==null)return;
        try{
            JSONObject restored=new JSONObject();
            for(Map.Entry<String,java.util.Set<String>> e:restoredIn.entrySet())restored.put(e.getKey(),new org.json.JSONArray(e.getValue()));
            JSONObject json=new JSONObject().put("boots",new org.json.JSONArray(boots)).put("restored",restored);
            File tmp=new File(history.getPath()+".tmp");
            java.nio.file.Files.write(tmp.toPath(),json.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            java.nio.file.Files.move(tmp.toPath(),history.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        }catch(Exception ignored){}
    }

    static String readBootId() throws Exception {
        return new String(java.nio.file.Files.readAllBytes(new File("/proc/sys/kernel/random/boot_id").toPath()),java.nio.charset.StandardCharsets.UTF_8).trim();
    }

    /** 与 Magisk 启动模块脚本相同：busybox ash 独立模式，PATH 带上 /debug_ramdisk（resetprop 在那里），脱离核心的会话。 */
    private static void launch(File script) throws Exception {
        ProcessBuilder builder=new ProcessBuilder(BUSYBOX,"setsid",BUSYBOX,"sh",script.getPath());
        Map<String,String> env=builder.environment();
        env.put("ASH_STANDALONE","1");
        String path=env.get("PATH");env.put("PATH",(path==null||path.isEmpty()?"/system/bin":path)+":/debug_ramdisk");
        File empty=new File("/dev/null");
        builder.redirectInput(ProcessBuilder.Redirect.from(empty)).redirectOutput(ProcessBuilder.Redirect.to(empty))
                .redirectError(ProcessBuilder.Redirect.to(empty)).start();
    }

    /** 在 /proc 里找命令行带这个脚本路径的进程（Magisk 启动的和核心补起的都算）。 */
    static boolean scriptRunning(String scriptPath) {
        File[] entries=new File("/proc").listFiles();if(entries==null)return false;
        for(File entry:entries) {
            if(!entry.getName().matches("[0-9]+"))continue;
            try(InputStream input=new FileInputStream(new File(entry,"cmdline"))) {
                byte[] buffer=new byte[4096];int length=input.read(buffer);if(length<=0)continue;
                for(String argument:new String(buffer,0,length,StandardCharsets.UTF_8).split("\0"))
                    if(argument.equals(scriptPath))return true;
            } catch(IOException ignored) {}
        }
        return false;
    }
}
