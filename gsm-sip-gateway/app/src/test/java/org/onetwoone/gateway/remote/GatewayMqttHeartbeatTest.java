package org.onetwoone.gateway.remote;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayMqttHeartbeatTest {
    static final class Driver implements GatewayMqttHeartbeat.Driver,AutoCloseable {
        final ExecutorService executor=Executors.newSingleThreadExecutor();final Map<String,Runnable> scheduled=new ConcurrentHashMap<>();
        final List<String> events=new CopyOnWriteArrayList<>();final List<Throwable> failures=new CopyOnWriteArrayList<>();
        final CountDownLatch acknowledged=new CountDownLatch(1);volatile boolean held;
        public void execute(Runnable action){executor.execute(action);}public void schedule(String key,long delay,Runnable action){scheduled.put(key,action);}
        public void cancel(String key){scheduled.remove(key);}public void hold(long timeout){held=true;}public void release(){held=false;}
        public void failed(Throwable error){failures.add(error);}public void event(String message){events.add(message);if(message.startsWith("mqtt_ping_ok"))acknowledged.countDown();}
        void flush()throws Exception{executor.submit(()->{}).get(3,TimeUnit.SECONDS);}void fire(String key)throws Exception{Runnable action=scheduled.remove(key);assertNotNull(key,action);executor.submit(action).get(3,TimeUnit.SECONDS);flush();}
        public void close(){executor.shutdownNow();}
    }
    static final class Broker implements AutoCloseable {
        final ServerSocket server=new ServerSocket(0);final CompletableFuture<Integer> received=new CompletableFuture<>();final CountDownLatch finish=new CountDownLatch(1);final Thread thread;volatile Socket socket;
        Broker(boolean respond)throws Exception{thread=new Thread(()->{try(Socket s=server.accept()){socket=s;s.setSoTimeout(3000);InputStream in=s.getInputStream();
            assertEquals(0x10,in.read());int length=0,multiplier=1,digit;do{digit=in.read();if(digit<0)throw new EOFException();length+=(digit&127)*multiplier;multiplier*=128;}while((digit&128)!=0);
            for(int i=0;i<length;i++)if(in.read()<0)throw new EOFException();s.getOutputStream().write(new byte[]{0x20,2,0,0});s.getOutputStream().flush();
            int type=in.read();assertEquals(0,in.read());received.complete(type);if(respond){s.getOutputStream().write(new byte[]{(byte)0xd0,0});s.getOutputStream().flush();}finish.await(5,TimeUnit.SECONDS);
        }catch(Throwable error){received.completeExceptionally(error);}},"gateway-heartbeat-broker");thread.setDaemon(true);thread.start();}
        public void close()throws Exception{finish.countDown();if(socket!=null)socket.close();server.close();thread.join(1000);}
    }
    static final class Fixture implements AutoCloseable {
        final Driver driver=new Driver();final AtomicLong clock=new AtomicLong(1000);final Broker broker;final GatewayMqttHeartbeat heartbeat;final MqttAsyncClient client;
        Fixture(boolean respond)throws Exception{broker=new Broker(respond);heartbeat=new GatewayMqttHeartbeat(driver,clock::get,20000);
            client=new MqttAsyncClient("tcp://127.0.0.1:"+broker.server.getLocalPort(),"gateway-heartbeat-test",new MemoryPersistence(),heartbeat,null,()->clock.get()*1000000);
            MqttConnectOptions options=new MqttConnectOptions();options.setKeepAliveInterval(900);client.connect(options).waitForCompletion(3000);driver.flush();driver.flush();}
        void ping()throws Exception{clock.addAndGet(901000);driver.fire("ping");assertEquals(Integer.valueOf(0xc0),broker.received.get(3,TimeUnit.SECONDS));}
        public void close()throws Exception{heartbeat.stop();driver.flush();client.disconnectForcibly(0,0,false);client.close(true);driver.flush();broker.close();driver.close();}
    }
    @Test public void blackholeFailsAtResponseDeadline()throws Exception{try(Fixture f=new Fixture(false)){f.ping();assertTrue(f.driver.held);assertTrue(f.driver.failures.isEmpty());f.clock.addAndGet(20000);f.driver.fire("ping-response");assertEquals(1,f.driver.failures.size());assertFalse(f.driver.held);}}
    @Test public void responseCancelsDeadlineAndSchedulesNextPing()throws Exception{try(Fixture f=new Fixture(true)){f.ping();assertTrue(f.driver.acknowledged.await(3,TimeUnit.SECONDS));f.driver.flush();assertFalse(f.driver.held);assertFalse(f.driver.scheduled.containsKey("ping-response"));assertTrue(f.driver.scheduled.containsKey("ping"));assertTrue(f.driver.failures.isEmpty());}}
    @Test public void stoppedConnectionIgnoresCapturedTimeout()throws Exception{try(Fixture f=new Fixture(false)){f.ping();Runnable old=f.driver.scheduled.get("ping-response");assertNotNull(old);f.heartbeat.stop();f.driver.flush();f.driver.executor.submit(old).get(3,TimeUnit.SECONDS);f.driver.flush();assertTrue(f.driver.failures.isEmpty());assertFalse(f.driver.held);}}
    @Test public void wifiAndCellularUseD22Intervals(){assertEquals(300,GatewayMqttHeartbeat.keepAliveSeconds(900,false));assertEquals(900,GatewayMqttHeartbeat.keepAliveSeconds(900,true));assertEquals(60,GatewayMqttHeartbeat.keepAliveSeconds(-1,false));}
}
