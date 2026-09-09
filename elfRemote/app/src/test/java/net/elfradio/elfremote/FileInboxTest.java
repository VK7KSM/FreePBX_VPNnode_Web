package net.elfradio.elfremote;
import org.junit.Test;
import org.json.*;
import static org.junit.Assert.*;

public class FileInboxTest {
    @Test public void oldCoreHistoryCannotReplaceLiveProgressAndHistoryIsBounded()throws Exception{
        JSONArray rows=new JSONArray();
        for(int i=0;i<25;i++)rows=FileInbox.merge(rows,new JSONObject().put("id","file-"+i).put("at",i).put("detail","保存完成"));
        assertEquals(20,rows.length());assertEquals("file-24",rows.getJSONObject(0).getString("id"));
        rows=FileInbox.merge(rows,new JSONObject().put("id","file-24").put("at",1).put("detail","旧记录"));
        assertEquals("保存完成",rows.getJSONObject(0).getString("detail"));
        rows=FileInbox.merge(rows,new JSONObject().put("id","file-24").put("at",100).put("detail","新进度"));
        assertEquals(20,rows.length());assertEquals("新进度",rows.getJSONObject(0).getString("detail"));
    }
    @Test public void coreHistoryContainsFileResultsButNoArbitraryCommand()throws Exception{
        java.io.File root=java.nio.file.Files.createTempDirectory("file-inbox").toFile();
        try{
            java.io.File dir=new java.io.File(root,"file-test");assertTrue(dir.mkdir());
            JSONObject p=new JSONObject().put("path","/sdcard/Download/example.jpg").put("size",123);
            RescueFiles.write(new java.io.File(dir,"request.json"),new JSONObject().put("command","file-commit:"+p).toString());
            RescueFiles.write(new java.io.File(dir,"result.json"),new JSONObject().put("state","completed").put("action","committed").put("finished",12345).toString());
            java.io.File other=new java.io.File(root,"command-test");assertTrue(other.mkdir());
            RescueFiles.write(new java.io.File(other,"request.json"),new JSONObject().put("command","id").toString());
            RescueFiles.write(new java.io.File(other,"result.json"),new JSONObject().put("state","completed").toString());
            RescueJobs jobs=new RescueJobs(root,(f,c,t)->{throw new AssertionError();});
            JSONArray rows=jobs.fileHistory().getJSONArray("files");assertEquals(1,rows.length());assertEquals("success",rows.getJSONObject(0).getString("state"));assertEquals(123,rows.getJSONObject(0).getLong("bytes"));
        }finally{try(java.util.stream.Stream<java.nio.file.Path> paths=java.nio.file.Files.walk(root.toPath())){paths.sorted(java.util.Comparator.reverseOrder()).forEach(p->p.toFile().delete());}}
    }
}
