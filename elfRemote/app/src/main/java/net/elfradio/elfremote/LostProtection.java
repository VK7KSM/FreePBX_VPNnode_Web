package net.elfradio.elfremote;

import android.app.*;
import android.content.Context;
import android.os.*;
import org.json.JSONObject;
import java.io.*;
import java.nio.channels.FileLock;
import java.lang.reflect.Method;

/** 独立核心保存和执行防丢策略；默认关闭，不通过本机HTTP增加擦除入口。 */
final class LostProtection implements Closeable {
    private static final File FILE=new File("/data/local/elfremote/lost-protection/state.json");
    private static final Object MUTEX=new Object();
    private static final int NOTICE=9124;
    private final Context context;
    private final HandlerThread thread;
    private final Handler handler;
    private final CoreWake wake;
    private long modified=-1,nextCheck;
    private int failures;
    private boolean closed;
    interface Edit {void apply(JSONObject s)throws Exception;}
    static String boot()throws Exception{return RescueFiles.read(new File("/proc/sys/kernel/random/boot_id"),128).trim();}
    static void recoverAttempt(JSONObject s)throws Exception {
        LostWipeAttempt.recover(s,SystemClock.elapsedRealtime(),boot(),(ownerBoot,pid,start)->{
            if(!boot().equals(ownerBoot))return false;
            File proc=new File("/proc/"+pid);if(!proc.exists())return false;
            // 读取失败不等于进程已死，不能据此宣布可取消。
            return start.equals(LostWipeAttempt.processStart(RescueFiles.read(new File(proc,"stat"),4096)));
        });
    }
    static JSONObject edit(Edit edit)throws Exception {
        synchronized(MUTEX){
            File parent=FILE.getParentFile();if(!parent.isDirectory()&&!parent.mkdir())throw new IOException("lost-state-directory-failed");
            android.system.Os.chmod(parent.getPath(),0700);
            try(RandomAccessFile gate=new RandomAccessFile(FILE.getPath()+".lock","rw");FileLock lock=gate.getChannel().lock()){
                android.system.Os.chmod(FILE.getPath()+".lock",0600);
                JSONObject s=FILE.isFile()?new JSONObject(RescueFiles.read(FILE,16384)):new JSONObject();String before=s.toString();
                edit.apply(s);if(!s.toString().equals(before)){RescueFiles.write(FILE,s.toString());android.system.Os.chmod(FILE.getPath(),0600);}return s;
            }
        }
    }
    static void contact(Boolean paired,long unpairedAt,long serverTime){
        if(!FILE.isFile())return;
        try{edit(s->{if(s.optBoolean("auto_wipe_enabled"))LostTimer.contact(s,paired,unpairedAt,serverTime>0?serverTime:System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot());});}
        catch(Exception e){RuntimeLog.event("lost-contact-persistence-failed");}
    }
    static boolean supported(){
        // 当前凭据适配已按Android 8的字符串合同实现；新平台需验证后才能开放。
        return Build.VERSION.SDK_INT>=26&&Build.VERSION.SDK_INT<=27;
    }
    static Method wipeMethod()throws Exception {
        return RecoverySystem.class.getMethod("rebootWipeUserData",Context.class,boolean.class,String.class,boolean.class);
    }
    static JSONObject snapshot(Context context,JSONObject s)throws Exception {
        long left=LostTimer.remaining(s,System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot());
        boolean active=s.optBoolean("enabled");
        boolean manual=s.has("manual_task")&&"armed".equals(s.optString("wipe_state"));
        if(manual)left=boot().equals(s.optString("manual_boot"))?Math.max(0,s.optLong("manual_elapsed")-SystemClock.elapsedRealtime()):Long.MAX_VALUE;
        return new JSONObject().put("version",2).put("enabled",active).put("state",s.optString("state",active?"enabled":"disabled"))
                .put("message",active?s.optString("message"):"").put("locked",new SystemLock(context).locked())
                .put("auto_wipe_enabled",s.optBoolean("auto_wipe_enabled")).put("timeout_hours",s.optInt("timeout_hours",24))
                .put("deadline_at",left==Long.MAX_VALUE?0:System.currentTimeMillis()+left)
                .put("trigger",manual?"manual":left==Long.MAX_VALUE?"":LostTimer.trigger(s,System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot()))
                .put("wipe_state",s.optString("wipe_state","idle")).put("revision",LostRevision.current(s)).put("revision_seq",s.optLong("revision_seq"))
                .put("restored",s.optBoolean("restored",!s.has("original_owner"))).put("clock_rebased",s.optBoolean("clock_rebased"));
    }
    static JSONObject request(Context context,JSONObject req)throws Exception {
        if(!supported())throw new IllegalStateException("lost-system-credential-unsupported");
        String action=req.getString("action");
        if(action.equals("contact")){contact(req.has("paired")?req.getBoolean("paired"):null,req.optLong("unpaired_at_ms"),req.optLong("server_time"));return snapshot(context,edit(s->{}));}
        if(action.equals("read"))return snapshot(context,edit(s->{}));
        if(action.equals("wipe")){
            String id=req.getString("task_id");long expiry=req.getLong("expires_at");
            if(!id.matches("[A-Za-z0-9-]{1,64}")||expiry<=System.currentTimeMillis()||expiry>System.currentTimeMillis()+120000||!"擦除数据".equals(req.optString("phrase")))throw new IllegalArgumentException("lost-wipe-confirmation-expired");
            wipeMethod();
            return snapshot(context,edit(s->{
                recoverAttempt(s);
                if(id.equals(s.optString("last_wipe_task")))return;
                LostRevision.require(s,req);
                if("started".equals(s.optString("wipe_state")))throw new IllegalStateException("lost-wipe-already-started");
                s.put("last_wipe_task",id).put("manual_task",id).put("manual_due",System.currentTimeMillis()+5000).put("manual_elapsed",SystemClock.elapsedRealtime()+5000).put("manual_boot",boot()).put("manual_expiry",expiry).put("wipe_state","armed");
            }));
        }
        if(!action.equals("set"))throw new IllegalArgumentException("lost-invalid-action");
        JSONObject input=LostModePolicy.params(req);
        if(input.optInt("version")!=2)throw new IllegalArgumentException("lost-client-update-required");
        final String task=req.optString("task_id");
        if(!task.matches("[A-Za-z0-9-]{1,64}"))throw new IllegalArgumentException("lost-invalid-task");
        SystemLock system=new SystemLock(context);
        JSONObject result=edit(s->{
            recoverAttempt(s);
            if(task.equals(s.optString("last_config_task")))return;
            if("started".equals(s.optString("wipe_state")))throw new IllegalStateException("lost-wipe-already-started");
            boolean active=input.getBoolean("enabled");
            boolean cancelOnly=req.optBoolean("cancel_auto");
            if(req.optBoolean("local_unlocked")&&system.locked())throw new IllegalStateException("lost-local-auth-required");
            if(active&&!cancelOnly)LostRevision.require(s,req);
            if(active&&s.has("restore_phase")&&!cancelOnly)throw new IllegalStateException("lost-restore-pending");
            if(!active||cancelOnly){
                // 取消先落盘并作废旧策略，随后恢复可能失败也不能继续自动清除。
                s.put("auto_wipe_enabled",false).put("wipe_state","idle");s.remove("manual_task");
                if(!task.equals(s.optString("cancellation_task"))){LostRevision.advance(s);s.put("cancellation_task",task);}
                if(!active&&!cancelOnly)s.put("state","pending");
                persist(s);
                if(cancelOnly){s.put("last_config_task",task);return;}
            }
            if(!active||!input.optBoolean("auto_wipe_enabled")){
                s.put("auto_wipe_enabled",false).put("wipe_state","idle");s.remove("manual_task");
                RescueFiles.write(FILE,s.toString());android.system.Os.chmod(FILE.getPath(),0600);
            }
            if(active){
                if(input.optBoolean("auto_wipe_enabled"))wipeMethod();
                String provided=input.optString("password"),existing=s.optString("credential"),password=provided.isEmpty()?existing:provided;
                if(password.isEmpty())throw new IllegalArgumentException("lost-password-required");
                if(system.secure()){
                    String check=existing.isEmpty()?password:existing;
                    if(!system.verify(check)){
                        String previous=s.optString("pending_old_credential");
                        if(previous.isEmpty()||!system.verify(previous))throw new IllegalArgumentException("lost-current-password-required");
                        existing=previous;
                    }
                    if(existing.isEmpty())existing=check;
                }
                if(!s.has("original_owner")){
                    String decrypt=system.decryptSetting();
                    if(decrypt!=null&&!decrypt.equals("0"))throw new IllegalStateException("lost-boot-password-required");
                    s.put("original_decrypt_setting",decrypt);
                    s.put("original_owner",system.owner()).put("original_secure",system.secure()).put("original_lock_disabled",system.disabled());
                    if(system.secure())s.put("original_credential",existing);
                }
                // 先保存恢复材料；系统调用中断也不能丢掉已设置的密码。
                s.put("restored",false).put("credential",password).put("pending_old_credential",existing).put("state","pending");RescueFiles.write(FILE,s.toString());android.system.Os.chmod(FILE.getPath(),0600);
                LostDebugGuard.restrict(s,()->persist(s));
                system.decryptSetting("0");
                system.password(password,existing);if(!system.secure()||!system.verify(password))throw new IllegalStateException("lost-system-password-failed");
                s.remove("pending_old_credential");
                system.owner(new JSONObject().put("enabled",true).put("message",input.getString("message")));system.lock();
                if(!system.locked())throw new IllegalStateException("lost-system-lock-pending");
            }else{
                LostRecovery.restore(s,system,()->persist(s));
                LostDebugGuard.restore(s);
                for(String key:new String[]{"credential","pending_old_credential","original_owner","original_secure","original_credential","original_decrypt_setting","original_lock_disabled","restore_phase","original_debug"})s.remove(key);
            }
            boolean wasArmed=s.optBoolean("auto_wipe_enabled");
            LostTimer.arm(s,active&&input.optBoolean("auto_wipe_enabled"),input.optInt("timeout_hours",24),req.optBoolean("paired",true),System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot());
            if(wasArmed&&active)LostTimer.contact(s,req.optBoolean("paired",true),req.optLong("unpaired_at_ms"),System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot());
            if(active)LostRevision.advance(s);
            s.put("enabled",active).put("message",active?input.getString("message"):"").put("state",active?"enabled":"disabled").put("last_config_task",task);
        });
        return snapshot(context,result);
    }
    private static void persist(JSONObject s)throws Exception {RescueFiles.write(FILE,s.toString());android.system.Os.chmod(FILE.getPath(),0600);}
    LostProtection()throws Exception {
        context=CoreWake.systemContext();thread=new HandlerThread("elfremote-lost-guard");thread.start();handler=new Handler(thread.getLooper());wake=new CoreWake(context,handler);refresh();
    }
    void refresh(){
        if(closed)return;long now=SystemClock.elapsedRealtime(),next=FILE.lastModified();
        if(next==modified&&(nextCheck==0||now<nextCheck))return;
        modified=next;nextCheck=now+60000;handler.post(this::evaluate);
    }
    private void evaluate(){
        if(closed)return;
        try{
            JSONObject s=edit(value->{
                recoverAttempt(value);
                LostWipeAttempt.retry(value,SystemClock.elapsedRealtime(),boot());
                LostTimer.checkpoint(value,System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot());
                if(value.optBoolean("enabled")&&!value.has("restore_phase")&&!"pending".equals(value.optString("state")))LostDebugGuard.restrict(value,()->persist(value));
            });
            long left=LostTimer.remaining(s,System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot());
            if(s.has("manual_task")&&"armed".equals(s.optString("wipe_state"))){
                if(!boot().equals(s.optString("manual_boot"))){edit(value->{value.remove("manual_task");value.put("wipe_state","failed");});return;}
                left=Math.max(0,s.optLong("manual_elapsed")-SystemClock.elapsedRealtime());
            }
            failures=0;nextCheck=(s.optBoolean("enabled")||s.optBoolean("auto_wipe_enabled"))?SystemClock.elapsedRealtime()+60000:0;
            if(left==Long.MAX_VALUE){wake.cancel("lost-deadline");notification(0,s.optBoolean("enabled"));return;}
            notification(System.currentTimeMillis()+left,s.optBoolean("enabled"));
            if(left>0){wake.schedule("lost-deadline",left,this::evaluate);return;}
            final boolean[] start={false};
            edit(current->{
                boolean manual=current.has("manual_task")&&"armed".equals(current.optString("wipe_state"));
                if(manual&&(current.optLong("manual_elapsed")>SystemClock.elapsedRealtime()||!boot().equals(current.optString("manual_boot"))))return;
                if(manual&&current.optLong("manual_expiry")<=System.currentTimeMillis()){current.remove("manual_task");current.put("wipe_state","failed");return;}
                if(!manual&&LostTimer.remaining(current,System.currentTimeMillis(),SystemClock.elapsedRealtime(),boot())!=0)return;
                LostWipeAttempt.started(current,!manual,boot(),android.os.Process.myPid(),LostWipeAttempt.processStart(RescueFiles.read(new File("/proc/self/stat"),4096)));
                current.put("wipe_started_at",System.currentTimeMillis());start[0]=true;
            });
            if(!start[0])return;
            RuntimeLog.event("lost-wipe-started");
            try{wake.hold("lost-wipe",120000);wipeMethod().invoke(null,context,false,"elfRemote 数据清除",true);}
            catch(Exception error){RuntimeLog.event("lost-wipe-failed");}
            finally{
                // 正常清除应终止当前系统；若调用返回或抛错，不能永久卡在已开始。
                edit(current->{LostWipeAttempt.failed(current,SystemClock.elapsedRealtime(),boot());});
                wake.release("lost-wipe");
            }
        }catch(Exception error){
            RuntimeLog.event("lost-guard-state-unavailable");
            long retry=Math.min(60000,1000L<<Math.min(6,failures++));nextCheck=SystemClock.elapsedRealtime()+retry;
            wake.schedule("lost-guard-retry",retry,this::evaluate);
        }
    }
    private void notification(long deadline,boolean enabled){
        try{
            // Android 8的锁屏不会可靠显示root UID通知，交给应用UID显示；广播仅刷新只读状态。
            java.lang.Process p=new ProcessBuilder("/system/bin/am","broadcast","--user","0","-n",BuildConfig.APPLICATION_ID+"/net.elfradio.elfremote.LostNoticeReceiver","--el","deadline_at",Long.toString(deadline),"--ez","lost_enabled",Boolean.toString(enabled)).redirectErrorStream(true).start();
            if(!p.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){p.destroy();RuntimeLog.event("lost-notice-dispatch-pending");}
        }catch(Exception error){RuntimeLog.error("lost-notice-dispatch-failed",error);}
    }
    public void close(){closed=true;wake.close();thread.quitSafely();}
}
