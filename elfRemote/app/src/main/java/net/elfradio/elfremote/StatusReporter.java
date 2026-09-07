package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.io.IOException;

final class StatusReporter {
    interface Transport { String post(String body) throws Exception; }
    private final StatusOutbox outbox;
    private final Transport transport;

    StatusReporter(StatusOutbox outbox, Transport transport) { this.outbox = outbox; this.transport = transport; }

    int flush(String token) throws Exception {
        int sent = 0;
        for (File file : outbox.entries()) {
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
            sent++;
        }
        return sent;
    }

    static long retryDelay(long base, int failures) {
        return Math.min(15 * 60_000L, base * (1L << Math.min(4, Math.max(0, failures))));
    }
}
