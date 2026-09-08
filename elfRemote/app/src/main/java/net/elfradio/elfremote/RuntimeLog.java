package net.elfradio.elfremote;

import java.io.File;
import java.util.UUID;

final class RuntimeLog {
    private static volatile RollingLog log;
    private static final String SESSION = UUID.randomUUID().toString().substring(0, 8);

    static void initialize(File directory, String version) {
        log = new RollingLog(directory, 512 * 1024, 4);
        event("process_start version=" + version);
    }

    static void event(String event) {
        RollingLog current = log;
        if (current != null) current.write(System.currentTimeMillis() + " mono_ns=" + System.nanoTime()
                + " run=" + SESSION + " " + event);
    }

    static void error(String event, Throwable error) {
        // 不写异常消息、请求正文或 URL 查询串，避免令牌进入诊断日志。
        String extra = error instanceof org.eclipse.paho.client.mqttv3.MqttException
                ? " mqtt_reason=" + ((org.eclipse.paho.client.mqttv3.MqttException)error).getReasonCode() : "";
        if (error.getCause() != null) extra += " cause=" + error.getCause().getClass().getSimpleName();
        event(event + " error=" + error.getClass().getSimpleName() + extra);
        StackTraceElement[] stack = error.getStackTrace();
        for (int i = 0; i < Math.min(4, stack.length); i++) event("at=" + stack[i].toString());
    }

    static boolean failed() { return log == null || log.failed(); }
    private RuntimeLog() {}
}
