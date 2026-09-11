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
        return flush(token,priorityRequest,null);
    }
    int flush(String token, String priorityRequest,String priorityReport) throws Exception {
        int sent = 0;
        File[] entries = outbox.entries();
        {
            boolean promoted=false;
            for (int i = 0; i < entries.length; i++) {
                JSONObject entry=outbox.read(entries[i]);
                if ((priorityRequest!=null&&priorityRequest.equals(entry.optString("status_request_id")))
                        ||(priorityReport!=null&&priorityReport.equals(entry.optString("report_id")))
                        ||(priorityRequest==null&&priorityReport==null&&entry.optJSONObject("report_event")!=null
                        &&"low_battery".equals(entry.getJSONObject("report_event").optString("type")))) {
                    File urgent = entries[i];
                    System.arraycopy(entries, 0, entries, 1, i);
                    entries[0] = urgent;
                    promoted=true;
                    break;
                }
            }
            // 网络恢复时先送最新已采集状态，第二份仍补最早历史；不重新采样或改写原件。
            if(!promoted&&priorityRequest==null&&priorityReport==null&&entries.length>1){
                File latest=entries[entries.length-1];
                System.arraycopy(entries,0,entries,1,entries.length-1);entries[0]=latest;
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
