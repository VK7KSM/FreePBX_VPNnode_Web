package net.elfradio.elfremote;

import org.junit.Test;
import static org.junit.Assert.*;
import java.net.ServerSocket;
import java.net.Socket;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.CompletableFuture;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.internal.ClientComms;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;

public class SleepPingClockTest {
    @Test public void elapsedClockAdvanceProducesPingWithoutWaitingForCpuTime() throws Exception {
        AtomicLong clock = new AtomicLong(1_000_000_000L);
        try (ServerSocket server = new ServerSocket(0)) {
            CompletableFuture<Integer> received = new CompletableFuture<>();
            Thread broker = new Thread(() -> {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(5000);
                    InputStream in = socket.getInputStream();
                    assertEquals(0x10, in.read());
                    int length = 0, multiplier = 1, digit;
                    do { digit = in.read(); length += (digit & 127) * multiplier; multiplier *= 128; } while ((digit & 128) != 0);
                    for (int i = 0; i < length; i++) if (in.read() < 0) throw new Exception("connect truncated");
                    socket.getOutputStream().write(new byte[]{0x20,2,0,0}); socket.getOutputStream().flush();
                    int type = in.read(); assertEquals(0, in.read());
                    received.complete(type);
                    socket.getOutputStream().write(new byte[]{(byte)0xd0,0});socket.getOutputStream().flush();
                    Thread.sleep(200);
                } catch (Throwable e) { received.completeExceptionally(e); }
            });
            broker.setDaemon(true);broker.start();
            ClientComms[] comms = new ClientComms[1];
            MqttPingSender sender = new MqttPingSender() {
                public void init(ClientComms value) { comms[0] = value; }
                public void start() { }
                public void stop() { }
                public void schedule(long delay) { }
            };
            MqttAsyncClient client = new MqttAsyncClient("tcp://127.0.0.1:" + server.getLocalPort(), "sleep-clock-test", new MemoryPersistence(), sender, null, clock::get);
            try {
                MqttConnectOptions options = new MqttConnectOptions();options.setKeepAliveInterval(60);
                client.connect(options).waitForCompletion(3000);
                clock.addAndGet(61_000_000_000L);
                MqttToken ping = comms[0].checkForActivity();assertNotNull(ping);ping.waitForCompletion(3000);
                assertEquals(Integer.valueOf(0xc0), received.get(3, java.util.concurrent.TimeUnit.SECONDS));
            } finally { client.disconnectForcibly(0,0,false);client.close(true); }
        }
    }
}
