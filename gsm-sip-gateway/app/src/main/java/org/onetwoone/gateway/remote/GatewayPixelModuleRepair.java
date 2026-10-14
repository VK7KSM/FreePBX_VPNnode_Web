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
 * 让手机开不了机，每次开机都被我们重新启用就会一直循环。所以同一模块 24 小时内最多恢复 3 次，第 4 次起保持停用、
 * 只记一次日志。恢复时间写在核心目录的文件里，重启后仍然有效；只计「去掉停用标记」，不计「拉起没在跑的限充脚本」。
 */
final class GatewayPixelModuleRepair {
    static final long RETRY_MS=10*60_000L;
    static final long BREAKER_WINDOW_MS=24*60*60_000L;
    static final int BREAKER_MAX=3;
    static final String BUSYBOX="/data/adb/magisk/busybox";

    interface Launcher { void start(File script) throws Exception; }
    interface Processes { boolean running(String scriptPath) throws Exception; }

    private final File root;private final Launcher launcher;private final Processes processes;
    private final Map<String,Long> lastAttempt=new HashMap<>();
    /** 去掉了停用标记、但脚本没能启动的模块：标记已去掉，下次重启自然会加载，在那之前仍按间隔重试立即生效。 */
    private final java.util.Set<String> pending=new java.util.HashSet<>();
    /** 恢复记录文件（null 时只记在内存里，仅供测试）。 */
    private final File history;
    private final Map<String,java.util.List<Long>> restores=new HashMap<>();
    private final java.util.Set<String> tripped=new java.util.HashSet<>();

    GatewayPixelModuleRepair(File root,Launcher launcher,Processes processes){this(root,launcher,processes,null);}
    GatewayPixelModuleRepair(File root,Launcher launcher,Processes processes,File history){
        this.root=root;this.launcher=launcher;this.processes=processes;this.history=history;loadHistory();
    }

    static GatewayPixelModuleRepair system(){
        return new GatewayPixelModuleRepair(new File("/data/adb/modules"),GatewayPixelModuleRepair::launch,GatewayPixelModuleRepair::scriptRunning,
                new File(GatewayCoreClient.DIR,"module-repair.json"));
    }

    /** 返回每个模块本次的处理结果：ok、restored、started、throttled、unrecognized、removing、failed，
     *  以及熔断的 tripped（刚熔断，记一次日志）和 held（熔断中，不再记日志）。 */
    synchronized JSONObject check(long now) throws Exception {
        JSONObject snapshot=GatewayPixelLegacyHealth.snapshot(root);
        return new JSONObject()
                .put("charge_bypass",repair(snapshot.getJSONObject("charge_bypass"),true,now))
                .put("sip_audio_access",repair(snapshot.getJSONObject("sip_audio_access"),false,now));
    }

    private String repair(JSONObject module,boolean keepsRunning,long now) {
        if(!module.optBoolean("recognized"))return "unrecognized";
        String id=module.optString("id");File directory=new File(root,id),script=new File(directory,"service.sh");
        if(new File(directory,"remove").exists())return "removing";
        boolean disabled=module.optBoolean("disabled");
        if(disabled&&recentRestores(id,now)>=BREAKER_MAX)return tripped.add(id)?"tripped":"held";
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
                recordRestore(id,now);
            }
            pending.add(id);
            if(!keepsRunning||!processes.running(script.getPath()))launcher.start(script);
            pending.remove(id);
            return disabled?"restored":"started";
        } catch(Exception failure) {
            return "failed";
        }
    }

    private int recentRestores(String id,long now){
        java.util.List<Long> list=restores.get(id);if(list==null)return 0;
        // 只算窗口内的；时钟被往回调过时，「未来」的记录也不作数
        list.removeIf(t->t<=now-BREAKER_WINDOW_MS||t>now+BREAKER_WINDOW_MS);
        return list.size();
    }

    private void recordRestore(String id,long now){
        restores.computeIfAbsent(id,k->new java.util.ArrayList<>()).add(now);
        saveHistory();
    }

    private void loadHistory(){
        if(history==null||!history.isFile()||history.length()>65536)return;
        try{
            JSONObject json=new JSONObject(new String(java.nio.file.Files.readAllBytes(history.toPath()),java.nio.charset.StandardCharsets.UTF_8));
            for(java.util.Iterator<String> it=json.keys();it.hasNext();){
                String id=it.next();org.json.JSONArray arr=json.optJSONArray(id);if(arr==null)continue;
                java.util.List<Long> list=new java.util.ArrayList<>();
                for(int i=0;i<arr.length()&&i<32;i++)list.add(arr.getLong(i));
                restores.put(id,list);
            }
        }catch(Exception ignored){}
    }

    private void saveHistory(){
        if(history==null)return;
        try{
            JSONObject json=new JSONObject();
            for(Map.Entry<String,java.util.List<Long>> e:restores.entrySet())json.put(e.getKey(),new org.json.JSONArray(e.getValue()));
            File tmp=new File(history.getPath()+".tmp");
            java.nio.file.Files.write(tmp.toPath(),json.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            java.nio.file.Files.move(tmp.toPath(),history.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        }catch(Exception ignored){}
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
