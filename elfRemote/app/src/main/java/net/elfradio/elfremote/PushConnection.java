package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.persist.MqttDefaultFilePersistence;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.SSLSocketFactory;

final class PushConnection {
    interface Receiver { void receive(JSONObject notification, Runnable acknowledge) throws Exception; }
    private final Context context;
    private final Handler worker;
    private final PairingStore pairing;
    private final Receiver receiver;
    private MqttAsyncClient client;
    private SharedPreferences prefs;
    private String identity = "";
    private String topic = "";
    private boolean connecting, subscribed, closed;
    private int failures;
    private String network = "";
    private final Runnable retry = this::connect;

    PushConnection(Context context, Handler worker, PairingStore pairing, Receiver receiver) {
        this.context = context; this.worker = worker; this.pairing = pairing; this.receiver = receiver;
    }

    void ensure() {
        if (closed) return;
        if (!pairing.paired()) {
            disposeClient(); worker.removeCallbacks(retry); identity = ""; prefs = null; return;
        }
        String next = PairingStore.sha256Hex(Protocol.BASE_URL + ":" + pairing.deviceId());
        if (!next.equals(identity)) {
            disposeClient();
            worker.removeCallbacks(retry);
            identity = next;
            prefs = context.getSharedPreferences("push-" + identity, Context.MODE_PRIVATE);
            failures = 0;
            connect();
        }
    }

    long lastVersion() { return prefs == null ? 0 : prefs.getLong("queued_version", 0); }
    void recordQueued(JSONObject value) throws Exception {
        if (!prefs.edit().putLong("queued_version", value.getLong("version")).commit()) throw new IOException("push receipt persistence failed");
    }
    boolean connected() { return subscribed && client != null && client.isConnected(); }
    private String activeNetwork() {
        android.net.ConnectivityManager manager = (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        android.net.Network active = manager == null ? null : manager.getActiveNetwork();
        return active == null ? "" : active.toString();
    }
    void networkHint() {
        if (closed || prefs == null) return;
        String current = activeNetwork();
        if (!network.equals(current)) {
            disposeClient();
            network = current;
            RuntimeLog.event("mqtt_network_changed");
        }
        if (!current.isEmpty() && !connecting && !connected()) connect();
    }

    private JSONObject identityBody() throws Exception {
        return new JSONObject().put("device_id", pairing.deviceId()).put("token", pairing.token());
    }

    private void connect() {
        if (closed || !pairing.paired() || connecting || connected()) return;
        worker.removeCallbacks(retry);
        connecting = true;
        try {
            network = activeNetwork();
            if (network.isEmpty()) throw new IOException("network unavailable");
            String saved = prefs.getString("connection", "");
            JSONObject config;
            if (saved.isEmpty()) {
                JSONObject reply = new JSONObject(HttpJson.post(Protocol.pushConfigPath(), identityBody().toString()));
                if (!reply.optBoolean("ok")) throw new IOException("push config unavailable");
                config = reply.getJSONObject("connection");
            } else config = new JSONObject(saved);
            String host = config.getString("host");
            String username = config.getString("username");
            int port = config.getInt("port");
            if (!config.optBoolean("tls") || !host.matches("[a-zA-Z0-9.-]+") || port < 1 || port > 65535
                    || !username.matches("d_[a-f0-9]{64}") || !username.equals(config.getString("client_id"))
                    || !("elfremote/" + username + "/notify").equals(config.getString("topic"))) throw new IOException("push config invalid");
            if (!prefs.edit().putString("connection", config.toString()).commit()) throw new IOException("push config persistence failed");
            topic = config.getString("topic");
            if (client == null) {
                File directory = new File(context.getFilesDir(), "mqtt/" + identity);
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("mqtt storage unavailable");
                client = new MqttAsyncClient("ssl://" + host + ":" + port, username, new MqttDefaultFilePersistence(directory.getPath()));
                client.setManualAcks(true);
                final MqttAsyncClient source = client;
                client.setCallback(new MqttCallback() {
                    public void connectionLost(Throwable error) {
                        worker.post(() -> { if (client == source && !closed) schedule(error); });
                    }
                    public void deliveryComplete(IMqttDeliveryToken token) {}
                    public void messageArrived(String receivedTopic, MqttMessage message) {
                        byte[] bytes = message.getPayload();
                        worker.post(() -> {
                            if (client != source || closed) return;
                            Runnable ack = () -> {
                                try { source.messageArrivedComplete(message.getId(), message.getQos()); }
                                catch (Exception error) { RuntimeLog.error("mqtt_ack_failed", error); }
                            };
                            try {
                                if (!topic.equals(receivedTopic) || bytes.length > 4096) { ack.run(); return; }
                                JSONObject notice;
                                try { notice = new JSONObject(new String(bytes, StandardCharsets.UTF_8)); }
                                catch (Exception invalid) { RuntimeLog.event("mqtt_invalid_notice"); ack.run(); return; }
                                receiver.receive(notice, ack);
                            } catch (Exception error) {
                                RuntimeLog.error("mqtt_notice_failed", error);
                                disposeClient();
                                schedule(error);
                            }
                        });
                    }
                });
            }
            MqttConnectOptions options = new MqttConnectOptions();
            options.setMqttVersion(MqttConnectOptions.MQTT_VERSION_3_1_1);
            options.setCleanSession(false);
            options.setAutomaticReconnect(false);
            options.setConnectionTimeout(15);
            options.setKeepAliveInterval(Math.max(60, Math.min(1800, config.optInt("keepalive_seconds", 900))));
            options.setMaxInflight(4);
            options.setUserName(username);
            options.setPassword(config.getString("password").toCharArray());
            options.setSocketFactory(SSLSocketFactory.getDefault());
            options.setHttpsHostnameVerificationEnabled(true);
            RuntimeLog.event("mqtt_connect_start");
            final MqttAsyncClient source = client;
            client.connect(options, null, new IMqttActionListener() {
                public void onSuccess(IMqttToken token) { worker.post(() -> subscribe(source)); }
                public void onFailure(IMqttToken token, Throwable error) { worker.post(() -> {
                    if (client != source || closed) return;
                    if (error instanceof MqttException && (((MqttException) error).getReasonCode() == 4 || ((MqttException) error).getReasonCode() == 5)) {
                        prefs.edit().remove("connection").commit();
                        disposeClient();
                    }
                    schedule(error);
                }); }
            });
        } catch (Exception error) { schedule(error); }
    }

    private void subscribe(MqttAsyncClient source) {
        if (closed || client != source) return;
        try {
            source.subscribe(topic, 1, null, new IMqttActionListener() {
                public void onSuccess(IMqttToken token) { worker.post(() -> {
                    if (closed || client != source) return;
                    if (token.getGrantedQos().length != 1 || token.getGrantedQos()[0] == 128) {
                        disposeClient(); schedule(new IOException("subscription refused")); return;
                    }
                    connecting = false; subscribed = true; failures = 0;
                    RuntimeLog.event("mqtt_subscribed");
                    sync();
                }); }
                public void onFailure(IMqttToken token, Throwable error) { worker.post(() -> {
                    if (client == source && !closed) { disposeClient(); schedule(error); }
                }); }
            });
        } catch (Exception error) { disposeClient(); schedule(error); }
    }

    void sync() {
        if (closed || !pairing.paired()) return;
        try {
            JSONObject reply = new JSONObject(HttpJson.post(Protocol.pushSyncPath(), identityBody().toString()));
            if (!reply.optBoolean("ok")) throw new IOException("push sync failed");
            JSONObject notification = reply.optJSONObject("status_request");
            if (notification != null) receiver.receive(notification, () -> {});
            RuntimeLog.event("push_sync_complete");
        } catch (Exception error) { RuntimeLog.error("push_sync_failed", error); }
    }

    private void schedule(Throwable error) {
        connecting = false; subscribed = false;
        if (closed) return;
        long delay = PushPolicy.retryDelay(failures++, Math.random());
        worker.removeCallbacks(retry);
        worker.postDelayed(retry, delay);
        RuntimeLog.event("mqtt_retry delay_ms=" + delay);
        if (error != null) RuntimeLog.error("mqtt_failed", error);
    }

    private void disposeClient() {
        MqttAsyncClient previous = client;
        client = null; connecting = false; subscribed = false;
        if (previous != null) {
            try { previous.disconnectForcibly(0, 500, false); } catch (Exception ignored) {}
            try { previous.close(true); } catch (Exception ignored) {}
        }
    }
    void close() { closed = true; worker.removeCallbacks(retry); disposeClient(); }
}
