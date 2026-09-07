package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.io.IOException;

final class StatusReporter {
    interface Transport { String post(String body) throws Exception; }
    interface Pending { void receive(JSONObject notification) throws Exception; }
    private final StatusOutbox outbox;
    private final Transport transport;
    private final Pending pending;

    StatusReporter(StatusOutbox outbox, Transport transport) { this(outbox, transport, notice -> {}); }
    StatusReporter(StatusOutbox outbox, Transport transport, Pending pending) {
        this.outbox = outbox; this.transport = transport; this.pending = pending;
    }

    int flush(String token) throws Exception {
        return flush(token, null);
    }

    int flush(String token, String priorityRequest) throws Exception {
        int sent = 0;
        File[] entries = outbox.entries();
        if (priorityRequest != null) {
            for (int i = 0; i < entries.length; i++) {
                if (priorityRequest.equals(outbox.read(entries[i]).optString("status_request_id"))) {
                    File urgent = entries[i];
                    System.arraycopy(entries, 0, entries, 1, i);
                    entries[0] = urgent;
                    break;
                }
            }
        }
        for (File file : entries) {
            if (sent == 2) break;
            JSONObject body = outbox.read(file);
            body.remove("queued_at_ms");
            body.put("token", token);
            body.put("status_only", true);
            JSONObject reply = new JSONObject(transport.post(body.toString()));
            if (!reply.optBoolean("ok") || !body.getString("report_id").equals(reply.optString("report_id"))) {
                throw new IOException("status acknowledgment missing");
            }
            // 此路径只消费状态回执，任何 update/task 字段都不进入执行器。
            if (!file.delete()) throw new IOException("status acknowledgment persistence failed");
            RuntimeLog.event("status_ack");
            JSONObject notice = reply.optJSONObject("status_request");
            if (notice != null) pending.receive(notice);
            sent++;
        }
        return sent;
    }

    static long retryDelay(long base, int failures) {
        return Math.min(15 * 60_000L, base * (1L << Math.min(4, Math.max(0, failures))));
    }
}
