package net.elfradio.elfremote;

import android.content.Context;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.internal.ClientComms;

final class AlarmPingSender implements MqttPingSender {
    private final Context context;
    private final WakeScheduler scheduler;
    private ClientComms comms;
    private volatile boolean running;
    AlarmPingSender(Context context) { this.context = context; scheduler = new WakeScheduler(context); }
    public void init(ClientComms comms) { this.comms = comms; }
    public void start() { running = true; schedule(comms.getKeepAlive()); }
    public void stop() { running = false; scheduler.cancel("ping"); WakeScheduler.release("ping"); }
    public void schedule(long delay) { if (running) scheduler.schedule("ping", delay); }
    void fire() {
        if (!running) return;
        WakeScheduler.hold(context, "ping", 30000L);
        RuntimeLog.event("mqtt_ping_wake");
        try {
            MqttToken token = comms.checkForActivity(new IMqttActionListener() {
                public void onSuccess(IMqttToken token) { WakeScheduler.release("ping"); RuntimeLog.event("mqtt_ping_ok"); }
                public void onFailure(IMqttToken token, Throwable error) { WakeScheduler.release("ping"); RuntimeLog.error("mqtt_ping_failed", error); }
            });
            if (token == null) WakeScheduler.release("ping");
        } catch (Exception e) { WakeScheduler.release("ping"); RuntimeLog.error("mqtt_ping_failed", e); }
    }
}
