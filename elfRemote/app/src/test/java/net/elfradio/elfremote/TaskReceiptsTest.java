package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class TaskReceiptsTest {
    @Test
    public void completedResultSurvivesRestartAndCannotBecomeFailure() throws Exception {
        File directory=Files.createTempDirectory("task-receipts").toFile();
        JSONObject result=new JSONObject().put("task_id","task-one").put("state","success").put("detail","done");
        new TaskReceipts(directory).save(result);
        TaskReceipts restarted=new TaskReceipts(directory);
        assertEquals("success",restarted.read("task-one").getString("state"));
        restarted.save(result);
        try { restarted.save(new JSONObject(result.toString()).put("state","failed")); fail(); }
        catch(java.io.IOException expected) { }
        assertEquals("success",restarted.read("task-one").getString("state"));
        assertNull(restarted.read("different"));
    }

    @Test
    public void corruptedResultFailsClosedAndCredentialsAreNotSaved() throws Exception {
        File directory=Files.createTempDirectory("task-receipts").toFile();
        TaskReceipts receipts=new TaskReceipts(directory);
        JSONObject value=new JSONObject().put("task_id","one").put("state","success");
        try { receipts.save(new JSONObject(value.toString()).put("token","fixture")); fail(); }
        catch(java.io.IOException expected) { }
        receipts.save(value);
        File target=directory.listFiles((dir,name)->name.endsWith(".json"))[0];
        Files.write(target.toPath(),new byte[]{0});
        try { receipts.read("one"); fail(); }
        catch(Exception expected) { }
    }
}
