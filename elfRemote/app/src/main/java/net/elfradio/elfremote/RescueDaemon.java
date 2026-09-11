package net.elfradio.elfremote;

import android.os.SystemClock;
import android.system.Os;
import org.json.JSONObject;
import java.io.*;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;

public final class RescueDaemon {
    private static final int OUTPUT_LIMIT = 65536;
    private static volatile int activeGroup;

    public static void main(String[] args) {
        try{run(args);}catch(Throwable failure){failure.printStackTrace(System.err);System.exit(1);}
    }
    private static void run(String[] args) throws Exception {
        if (Os.getuid() != 0 || args.length != 2) return;
        System.out.println("CORE_BOOT_BEGIN version="+BuildConfig.VERSION_CODE);
        File root = new File(args[0]);
        File guard = new File(args[1]);
        if (!guard.isFile()) return;
        String generation = RescueFiles.read(guard, 128);
        try (RandomAccessFile lockFile = new RandomAccessFile(new File(root, "daemon.lock"), "rw");
             FileLock lock = lockFile.getChannel().tryLock()) {
            if (lock == null) {System.out.println("CORE_ALREADY_RUNNING");return;}
            RescueFiles.write(new File(root,"daemon.pid"),Integer.toString(android.os.Process.myPid()));
            try { RescueFiles.write(new File(root,"started.json"),RescueDiagnostics.collect().toString()); }
            catch(Exception unavailable) { System.err.println("核心启动诊断暂不可用，继续启动命令服务"); }
            RuntimeLog.initialize(new File(root,"runtime-log"),BuildConfig.VERSION_NAME);
            RescueJobs jobs = new RescueJobs(new File(root, "jobs"), RescueDaemon::execute);
            RescueHttpServer server = new RescueHttpServer(8765, jobs, () -> status(guard), Os.getuid());
            AdbSessions adb=new AdbSessions(jobs,root);server.setAdb(adb);
            LostProtection lost=null;long lostRetryAt=0;
            CorePush push=null;
            long pushRetryAt=0;int pushFailures=0;
            server.start(3000, true);
            System.out.println("CORE_HTTP_READY version="+BuildConfig.VERSION_CODE);
            try {
                while (guard.isFile() && generation.equals(RescueFiles.read(guard, 128))) {
                    if(push==null&&SystemClock.elapsedRealtime()>=pushRetryAt) {
                        try{push=new CorePush(root);server.setPush(push);RuntimeLog.event("core_push_initialized");}
                        catch(Exception failure){
                            long delay=Math.min(300000L,5000L<<Math.min(6,pushFailures++));
                            pushRetryAt=SystemClock.elapsedRealtime()+delay;
                            RuntimeLog.error("core_push_start_failed",failure);RuntimeLog.event("core_push_initialize_retry delay_ms="+delay);
                        }
                    }
                    if(lost==null&&SystemClock.elapsedRealtime()>=lostRetryAt)try{lost=new LostProtection();}catch(Exception e){lostRetryAt=SystemClock.elapsedRealtime()+60000;RuntimeLog.event("lost-guard-start-pending");}
                    if(lost!=null)lost.refresh();
                    Thread.sleep(2000);
                }
            } finally {
                if(lost!=null)lost.close();
                if(push!=null)push.close();
                adb.close();
                killGroup(activeGroup);
                server.stop();
                new File(root,"daemon.pid").delete();
            }
        }
        System.exit(0);
    }

    static JSONObject execute(File folder, String command, int timeout) throws Exception {
        File cancel=new File(folder,"cancel");
        if (cancel.exists()) return new JSONObject().put("state","cancelled").put("exit_code",JSONObject.NULL).put("output","");
        File script = new File(folder, "command.sh");
        File pidFile = new File(folder, "group.pid");
        RescueFiles.write(script, command + "\n");
        Process process = new ProcessBuilder("/system/bin/setsid", "/system/bin/sh", "-c",
                "echo $$ > \"$1\"; exec /system/bin/sh \"$2\"", "rescue",
                pidFile.getPath(), script.getPath()).redirectErrorStream(true).start();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        boolean[] truncated = {false};
        Thread reader = new Thread(() -> {
            try (InputStream in = process.getInputStream()) {
                byte[] buf = new byte[4096]; int n;
                while ((n = in.read(buf)) != -1) {
                    synchronized (output) {
                        int keep = Math.min(n, OUTPUT_LIMIT - output.size());
                        output.write(buf, 0, keep);
                        if (keep < n) truncated[0] = true;
                    }
                }
            } catch (IOException ignored) { }
        }, "elfremote-rescue-output");
        reader.setDaemon(true); reader.start();
        long start = SystemClock.elapsedRealtime();
        Integer exit = null;
        boolean timedOut = false;
        boolean cancelled = false;
        try {
            while (exit == null) {
                if (cancel.exists()) { cancelled=true; break; }
                if (activeGroup == 0 && pidFile.isFile()) {
                    try { activeGroup = Integer.parseInt(RescueFiles.read(pidFile, 32).trim()); }
                    catch (NumberFormatException ignored) { }
                }
                if (activeGroup > 1) {
                    try {
                        Integer status = waitChild(activeGroup);
                        if (status != null) {
                            exit = android.system.OsConstants.WIFEXITED(status)
                                    ? android.system.OsConstants.WEXITSTATUS(status)
                                    : 128 + android.system.OsConstants.WTERMSIG(status);
                        }
                    } catch (Exception reaped) {
                        try { exit = process.exitValue(); }
                        catch (IllegalThreadStateException running) { }
                    }
                }
                if (exit != null) break;
                if (SystemClock.elapsedRealtime() - start >= timeout * 1000L) { timedOut = true; break; }
                Thread.sleep(50);
            }
        } finally {
            if (activeGroup == 0 && pidFile.isFile()) {
                try { activeGroup = Integer.parseInt(RescueFiles.read(pidFile, 32).trim()); }
                catch (Exception ignored) { }
            }
            // 清理同进程组子进程；不会撤销已经完成的写入。
            killGroup(activeGroup); activeGroup = 0;
            if (exit == null) process.destroy();
            if (timedOut && pidFile.isFile()) {
                try {
                    int childPid = Integer.parseInt(RescueFiles.read(pidFile, 32).trim());
                    for (int n = 0; n < 20; n++) {
                        if (waitChild(childPid) != null) break;
                        Thread.sleep(25);
                    }
                } catch (Exception ignored) { }
            }
            reader.join(1500);
            if (reader.isAlive()) process.getInputStream().close();
        }
        String text;
        synchronized (output) { text = new String(output.toByteArray(), StandardCharsets.UTF_8); }
        RescueFiles.write(new File(folder, "output.txt"), text);
        return new JSONObject().put("state", cancelled ? "cancelled" : timedOut ? "timed_out" : "completed")
                .put("exit_code", exit == null ? JSONObject.NULL : exit)
                .put("output", text).put("truncated", truncated[0])
                .put("elapsed_ms", SystemClock.elapsedRealtime() - start);
    }

    private static void killGroup(int pid) {
        if (pid > 1) try { Os.kill(-pid, 9); } catch (Exception ignored) { }
    }

    private static Integer waitChild(int pid) throws Exception {
        // Android 6将waitpid隐藏于SDK之外，独立app_process需显式回收子进程。
        Class<?> holder = Class.forName("android.util.MutableInt");
        Object status = holder.getConstructor(int.class).newInstance(0);
        int result = (Integer) Os.class.getMethod("waitpid", int.class, holder, int.class)
                .invoke(null, pid, status, android.system.OsConstants.WNOHANG);
        return result > 0 ? holder.getField("value").getInt(status) : null;
    }

    private static String status(File guard) {
        String report = "elfRemote 独立root维护 " + BuildConfig.VERSION_NAME
                + "\n本机维护端口：8765\n运行毫秒：" + SystemClock.elapsedRealtime()
                + "\n命令入口：POST /exec；结果入口：GET /jobs/任务号\n";
        try { return report + "本机实时诊断：\n" + RescueDiagnostics.collect().toString(2) + "\n"; }
        catch (Exception ignored) { return report + "诊断读取失败，命令服务仍可独立使用。\n"; }
    }
}
