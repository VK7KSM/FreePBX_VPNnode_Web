package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.util.function.LongSupplier;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.internal.ClientComms;

/** D22 同款心跳合同：回复有独立期限，旧连接回调不能影响新连接。 */
final class GatewayMqttHeartbeat implements MqttPingSender {
    static final long RESPONSE_TIMEOUT_MS=20000;
    interface Driver {
        void execute(Runnable action);
        void schedule(String key,long delay,Runnable action);
        void cancel(String key);
        void hold(long timeout);
        void release();
        void failed(Throwable error);
        void event(String message);
    }
    private final Driver driver;private final LongSupplier clock;private final long responseTimeout;
    private ClientComms comms;private volatile boolean closed;private boolean running;private MqttToken pending;private long started;
    GatewayMqttHeartbeat(Driver driver,LongSupplier clock){this(driver,clock,RESPONSE_TIMEOUT_MS);}
    GatewayMqttHeartbeat(Driver driver,LongSupplier clock,long timeout){this.driver=driver;this.clock=clock;responseTimeout=timeout;}
    static int keepAliveSeconds(int configured,boolean wifi){return Math.max(60,Math.min(wifi?900:300,configured));}
    public void init(ClientComms value){comms=value;}
    public void start(){driver.execute(()->{if(!closed){running=true;schedule(comms.getKeepAlive());}});}
    public void stop(){closed=true;driver.execute(()->{running=false;pending=null;driver.cancel("ping");driver.cancel("ping-response");driver.release();});}
    public void schedule(long delay){driver.execute(()->{if(running&&!closed)driver.schedule("ping",delay,this::fire);});}
    private void fire(){
        if(closed||!running||pending!=null)return;
        driver.hold(responseTimeout+5000);driver.event("mqtt_ping_wake");started=clock.getAsLong();
        try {
            MqttToken token=comms.checkForActivity(new IMqttActionListener(){
                public void onSuccess(IMqttToken value){driver.execute(()->complete(value,null));}
                public void onFailure(IMqttToken value,Throwable error){driver.execute(()->complete(value,error));}
            });
            if(token==null){driver.release();driver.event("mqtt_ping_not_due");return;}
            pending=token;driver.event("mqtt_ping_queued");
            driver.schedule("ping-response",responseTimeout,()->{
                if(!closed&&pending==token){
                    if(token.isComplete()){complete(token,token.getException());return;}
                    driver.event("mqtt_ping_timeout");fail(new IOException("MQTT heartbeat response timeout"));
                }
            });
        } catch(Exception error){fail(error);}
    }
    private void complete(IMqttToken token,Throwable error){
        if(closed||!running||pending!=token)return;
        pending=null;driver.cancel("ping-response");driver.release();
        if(error!=null){driver.event("mqtt_ping_failed");fail(error);}
        else driver.event("mqtt_ping_ok elapsed_ms="+(clock.getAsLong()-started));
    }
    private void fail(Throwable error){if(closed)return;stop();driver.failed(error);}
}
