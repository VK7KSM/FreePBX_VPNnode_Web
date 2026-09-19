package net.elfradio.elfremote.diagnostics;

import android.app.AlarmManager;
import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** 独立云连接迁移前的有限闹钟验证，不建立网络连接、不修改应用配置。 */
public final class CloudWakeProbe {
    public static void main(String[] args) throws Exception {
        boolean systemOwner = args.length == 1 && "--system-owner".equals(args[0]);
        JSONObject result = new JSONObject().put("probe", "independent-alarm-v3").put("system_owner", systemOwner);
        HandlerThread thread = null;
        AlarmManager alarms = null;
        AlarmManager.OnAlarmListener listener = null;
        int status = 1;
        try {
            if (systemOwner ? Process.myUid() != 0 : Process.myUid() < 10000)
                throw new IllegalStateException("运行身份不符合指定验证模式");
            Looper.prepareMainLooper();
            Object activity = Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
            Context system = (Context) activity.getClass().getMethod("getSystemContext").invoke(activity);
            Context context = systemOwner ? system : system.createPackageContext("net.elfradio.elfremote", Context.CONTEXT_IGNORE_SECURITY);
            if (!systemOwner) {
                boolean matchingUid = context.getApplicationInfo().uid == Process.myUid();
                result.put("application_uid_matches", matchingUid);
                if (!matchingUid) throw new IllegalStateException("运行UID与目标应用不一致");
            }
            thread = new HandlerThread("elfremote-cloud-wake-check"); thread.start();
            Handler handler = new Handler(thread.getLooper());
            CountDownLatch received = new CountDownLatch(1);
            long[] delivered = {0};
            listener = new AlarmManager.OnAlarmListener() {
                @Override public void onAlarm() { delivered[0] = SystemClock.elapsedRealtime(); received.countDown(); }
            };
            alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            long scheduled = SystemClock.elapsedRealtime(), due = scheduled + 5000;
            alarms.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, due, "elfRemote:cloud-wake-check", listener, handler);
            result.put("registered_elapsed_ms", scheduled).put("due_elapsed_ms", due);
            System.out.println("ALARM_REGISTERED"); System.out.flush();
            boolean fired = received.await(20, TimeUnit.SECONDS);
            result.put("alarm_fired", fired).put("requested_delay_ms", 5000)
                    .put("actual_delay_ms", fired ? delivered[0] - scheduled : JSONObject.NULL)
                    .put("lateness_ms", fired ? delivered[0] - due : JSONObject.NULL)
                    .put("network_opened", false);
            status = fired ? 0 : 2;
        } catch (Throwable error) {
            result.put("error_type", error.getClass().getSimpleName()).put("error", String.valueOf(error.getMessage()));
        } finally {
            if (alarms != null && listener != null) try { alarms.cancel(listener); } catch (Exception ignored) { }
            if (thread != null) thread.quitSafely();
            System.out.println(result.toString());
        }
        System.exit(status);
    }
}
