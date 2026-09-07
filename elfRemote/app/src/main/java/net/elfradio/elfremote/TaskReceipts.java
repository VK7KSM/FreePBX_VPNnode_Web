package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

final class TaskReceipts {
    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private final File directory;
    TaskReceipts(File directory) { this.directory = directory; }

    static boolean terminal(String state) {
        return "success".equals(state) || "failed".equals(state) || "rejected".equals(state) || "expired".equals(state);
    }

    private File target(String id) throws IOException {
        if (id == null || id.isEmpty() || id.length() > 128) throw new IOException("task id invalid");
        return new File(directory, UpdatePolicy.sha256Hex(id.getBytes(StandardCharsets.UTF_8)) + ".json");
    }

    synchronized JSONObject read(String id) throws Exception {
        File file = target(id);
        if (!file.exists()) return null;
        if (file.length() > MAX_BYTES) throw new IOException("task receipt too large");
        try (FileInputStream input = new FileInputStream(file)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[2048];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > MAX_BYTES) throw new IOException("task receipt too large");
                bytes.write(buffer, 0, count);
            }
            JSONObject value = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            if (!id.equals(value.optString("task_id")) || !terminal(value.optString("state"))) throw new IOException("task receipt invalid");
            return value;
        }
    }

    synchronized void save(JSONObject value) throws Exception {
        if (value.has("token") || !terminal(value.optString("state"))) throw new IOException("task receipt invalid");
        String id = value.getString("task_id");
        JSONObject existing = read(id);
        if (existing != null) {
            if (!existing.toString().equals(value.toString())) throw new IOException("task result already committed");
            return;
        }
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("task receipt storage unavailable");
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("task receipt too large");
        File temporary = new File(directory, "receipt.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); output.getFD().sync(); }
        if (!temporary.renameTo(target(id))) throw new IOException("task receipt commit failed");
    }
}
