package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

final class StatusOutbox {
    private final File directory;
    private final int limit;

    StatusOutbox(File directory, int limit) { this.directory = directory; this.limit = limit; }

    synchronized void add(JSONObject record) throws Exception {
        if (record.has("token")) throw new IOException("credentials must not be queued");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("outbox unavailable");
        String id = record.getString("report_id");
        if (!id.matches("[a-zA-Z0-9-]{1,96}")) throw new IOException("invalid report id");
        byte[] bytes = record.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 8192) throw new IOException("report too large");
        File target = new File(directory, record.getLong("queued_at_ms") + "-" + id + ".json");
        if (target.exists()) return;
        File temporary = new File(directory, "pending.tmp");
        try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(bytes); out.getFD().sync(); }
        if (!temporary.renameTo(target)) throw new IOException("outbox commit failed");
        File[] entries = entries();
        for (int i = 0; i < entries.length - limit; i++) {
            if (!entries[i].delete()) throw new IOException("outbox capacity cleanup failed");
            RuntimeLog.event("outbox_gap reason=capacity");
        }
    }

    synchronized File[] entries() {
        File[] entries = directory.listFiles((dir, name) -> name.endsWith(".json"));
        if (entries == null) return new File[0];
        Arrays.sort(entries, (a,b) -> a.getName().compareTo(b.getName()));
        return entries;
    }

    JSONObject read(File file) throws Exception {
        if (file.length() > 8192) throw new IOException("queued report too large");
        try (FileInputStream in = new FileInputStream(file)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (out.size() + count > 8192) throw new IOException("queued report too large");
                out.write(buffer, 0, count);
            }
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
    }
}
