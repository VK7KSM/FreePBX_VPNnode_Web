package net.elfradio.elfremote;

import java.util.ResourceBundle;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.eclipse.paho.client.mqttv3.logging.Logger;
import org.eclipse.paho.client.mqttv3.logging.LoggerFactory;

/** 仅保存Paho 1.2.5的心跳写出/解码事件，禁止展开身份、主题、载荷或异常参数。 */
public final class MqttWireLog implements Logger {
    private static final AtomicInteger sequence = new AtomicInteger();
    private static volatile Consumer<String> destination;
    private Consumer<String> sink;
    private int connection, sent, received;
    public static void install(Consumer<String> target) {
        destination=target;
        LoggerFactory.setLogger(MqttWireLog.class.getName());
    }
    public void initialise(ResourceBundle bundle,String logger,String resource) {
        sink=destination;
        connection=sequence.incrementAndGet();
    }
    public void setResourceName(String name) {}
    public boolean isLoggable(int level) {return false;}
    private synchronized void event(String source,String method,String code) {
        if(sink==null || !"org.eclipse.paho.client.mqttv3.internal.ClientState".equals(source))return;
        String message;
        // CommsSender在成功flush之后才调用notifySent；此事件不代表服务器已收到。
        if("notifySent".equals(method)&&"635".equals(code))
            message="core_mqtt_ping_sent wire_connection="+connection+" ping="+(++sent);
        else if("notifyReceivedAck".equals(method)&&"636".equals(code))
            message="core_mqtt_ping_received wire_connection="+connection+" ping="+(++received);
        else return;
        try {sink.accept(message);}catch(RuntimeException ignored) { /* 记录失败不能改变连接状态。 */ }
    }
    public void severe(String source,String method,String code) {}
    public void severe(String source,String method,String code,Object[] args) {}
    public void severe(String source,String method,String code,Object[] args,Throwable error) {}
    public void warning(String source,String method,String code) {}
    public void warning(String source,String method,String code,Object[] args) {}
    public void warning(String source,String method,String code,Object[] args,Throwable error) {}
    public void info(String source,String method,String code) {}
    public void info(String source,String method,String code,Object[] args) {}
    public void info(String source,String method,String code,Object[] args,Throwable error) {}
    public void config(String source,String method,String code) {}
    public void config(String source,String method,String code,Object[] args) {}
    public void config(String source,String method,String code,Object[] args,Throwable error) {}
    public void fine(String source,String method,String code) {event(source,method,code);}
    public void fine(String source,String method,String code,Object[] args) {event(source,method,code);}
    public void fine(String source,String method,String code,Object[] args,Throwable error) {event(source,method,code);}
    public void finer(String source,String method,String code) {}
    public void finer(String source,String method,String code,Object[] args) {}
    public void finer(String source,String method,String code,Object[] args,Throwable error) {}
    public void finest(String source,String method,String code) {}
    public void finest(String source,String method,String code,Object[] args) {}
    public void finest(String source,String method,String code,Object[] args,Throwable error) {}
    public void log(int level,String source,String method,String code,Object[] args,Throwable error) {}
    public void trace(int level,String source,String method,String code,Object[] args,Throwable error) {}
    public String formatMessage(String code,Object[] args) {return "";}
    public void dumpTrace() {}
}
