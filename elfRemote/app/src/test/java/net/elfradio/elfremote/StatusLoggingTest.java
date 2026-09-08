package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class StatusLoggingTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private JSONObject sample(String id, long at) throws Exception {
        return new JSONObject().put("report_id",id).put("device_id","fixture-device")
                .put("queued_at_ms",at).put("reported_at","2026-09-07T00:00:00Z");
    }

    @Test public void logSurvivesProcessRestartAndRotates() throws Exception {
        File dir=temporary.newFolder();
        RollingLog first=new RollingLog(dir,128,3);
        assertTrue(first.write("offline-before-restart"));
        RollingLog restarted=new RollingLog(dir,128,3);
        assertTrue(restarted.write("online-after-restart"));
        String text=new String(Files.readAllBytes(new File(dir,"runtime-0.log").toPath()),StandardCharsets.UTF_8);
        assertTrue(text.contains("offline-before-restart"));
        assertTrue(text.contains("online-after-restart"));
        for(int i=0;i<100;i++) assertTrue(restarted.write("event-"+i+" network-unavailable"));
        assertTrue(dir.listFiles().length<=3);
        for(File file:dir.listFiles()) assertTrue(file.length()<=128);
    }

    @Test public void logWriteFailureDoesNotCrashAndCanRecover() throws Exception {
        File target=temporary.newFile();
        RollingLog log=new RollingLog(target,1024,3);
        assertFalse(log.write("offline")); assertTrue(log.failed());
        assertTrue(target.delete()); assertTrue(target.mkdir());
        assertTrue(log.write("recovered")); assertFalse(log.failed());
    }

    @Test public void diagnosticErrorsDoNotStoreSecretMessages() throws Exception {
        File dir=temporary.newFolder();
        RuntimeLog.initialize(dir,"test");
        RuntimeLog.error("failed",new IOException("token=should-never-be-logged"));
        String text=new String(Files.readAllBytes(new File(dir,"runtime-0.log").toPath()),StandardCharsets.UTF_8);
        assertTrue(text.contains("IOException")); assertFalse(text.contains("should-never-be-logged"));
    }

    @Test public void failedSendSurvivesRestartAndRetriesSameReport() throws Exception {
        File dir=temporary.newFolder();
        StatusOutbox first=new StatusOutbox(dir,10);
        first.add(sample("first",1));
        try { new StatusReporter(first,body->{throw new IOException("offline");}).flush("fixture-token"); fail(); }
        catch(IOException expected) { }
        StatusOutbox restarted=new StatusOutbox(dir,10);
        assertEquals(1,restarted.entries().length);
        assertFalse(restarted.read(restarted.entries()[0]).has("token"));
        List<JSONObject> sent=new ArrayList<>();
        int count=new StatusReporter(restarted,body->{
            JSONObject request=new JSONObject(body); sent.add(request);
            return new JSONObject().put("ok",true).put("report_id",request.getString("report_id"))
                    .put("update",new JSONObject().put("command","must-not-run"))
                    .put("task",new JSONObject().put("type","reboot")).toString();
        }).flush("fixture-token");
        assertEquals(1,count); assertEquals(0,restarted.entries().length);
        assertEquals("first",sent.get(0).getString("report_id"));
        assertTrue(sent.get(0).getBoolean("status_only"));
        assertEquals("fixture-token",sent.get(0).getString("token"));
    }

    @Test public void wrongAcknowledgmentKeepsPendingRecord() throws Exception {
        StatusOutbox outbox=new StatusOutbox(temporary.newFolder(),10);
        outbox.add(sample("pending",1));
        try { new StatusReporter(outbox,body->"{\"ok\":true,\"report_id\":\"other\"}").flush("token"); fail(); }
        catch(IOException expected) { }
        assertEquals(1,outbox.entries().length);
    }

    @Test public void boundedQueueAndUploadBatch() throws Exception {
        StatusOutbox outbox=new StatusOutbox(temporary.newFolder(),3);
        for(int i=0;i<5;i++) outbox.add(sample("id-"+i,100+i));
        assertEquals(3,outbox.entries().length);
        assertEquals("id-2",outbox.read(outbox.entries()[0]).getString("report_id"));
        int count=new StatusReporter(outbox,body->new JSONObject().put("ok",true)
                .put("report_id",new JSONObject(body).getString("report_id")).toString()).flush("token");
        assertEquals(2,count); assertEquals(1,outbox.entries().length);
    }

    @Test public void outboxRejectsPersistedCredentials() throws Exception {
        StatusOutbox outbox=new StatusOutbox(temporary.newFolder(),3);
        try { outbox.add(sample("bad",1).put("token","secret")); fail(); }
        catch(IOException expected) { }
        assertEquals(0,outbox.entries().length);
    }

    @Test public void requestedStatusDoesNotWaitBehindOfflineBacklog() throws Exception {
        StatusOutbox outbox = new StatusOutbox(temporary.newFolder(), 20);
        for (int i = 0; i < 10; i++) outbox.add(sample("old-" + i, 100 + i));
        outbox.add(sample("urgent", 999).put("status_request_id", "request-current"));
        assertTrue(outbox.containsRequest("request-current"));
        List<String> sent = new ArrayList<>();
        new StatusReporter(outbox, body -> {
            String id = new JSONObject(body).getString("report_id");
            sent.add(id);
            return new JSONObject().put("ok", true).put("report_id", id).toString();
        }).flush("fixture-token", "request-current");
        assertEquals(java.util.Arrays.asList("urgent", "old-0"), sent);
        assertEquals(9, outbox.entries().length);
        assertFalse(outbox.containsRequest("request-current"));
    }

    @Test public void reportReplyCanOfferMissedNotificationAfterSuccessfulAck() throws Exception {
        StatusOutbox outbox = new StatusOutbox(temporary.newFolder(), 10);
        outbox.add(sample("report", 1));
        List<JSONObject> notices = new ArrayList<>();
        new StatusReporter(outbox, body -> new JSONObject().put("ok", true).put("report_id", "report")
                .put("status_request", new JSONObject().put("request_id", "missed")).toString(), notices::add).flush("token");
        assertEquals(0, outbox.entries().length);
        assertEquals("missed", notices.get(0).getString("request_id"));
    }

    @Test public void httpFailsBeforeAnyNetworkOrFileWrite() throws Exception {
        try { HttpJson.get("http://127.0.0.1:1/test"); fail(); }
        catch(IOException expected) { assertTrue(expected.getMessage().contains("HTTPS")); }
        File dest=new File(temporary.getRoot(),"download.apk");
        try { HttpJson.download("http://127.0.0.1:1/test",dest); fail(); }
        catch(IOException expected) { }
        assertFalse(dest.exists());
    }

    @Test public void failedReportsUseBoundedBackoff() {
        assertEquals(60000,StatusReporter.retryDelay(60000,0));
        assertEquals(120000,StatusReporter.retryDelay(60000,1));
        assertEquals(900000,StatusReporter.retryDelay(60000,20));
    }

    @org.junit.Test public void malformedFirstReportIsPreservedWithoutBlockingLaterReports() throws Exception {
        java.io.File dir=java.nio.file.Files.createTempDirectory("outbox-corrupt").toFile();
        java.nio.file.Files.write(new java.io.File(dir,"000-invalid.json").toPath(), "broken-json".getBytes("UTF-8"));
        StatusOutbox box=new StatusOutbox(dir,10);
        box.add(new org.json.JSONObject().put("report_id","good").put("queued_at_ms",1000));
        org.junit.Assert.assertEquals(1,box.entries().length);
        org.junit.Assert.assertEquals("good",box.read(box.entries()[0]).getString("report_id"));
        java.io.File[] originals=new java.io.File(dir,"invalid").listFiles();
        org.junit.Assert.assertEquals(1,originals.length);
        org.junit.Assert.assertEquals("broken-json",new String(java.nio.file.Files.readAllBytes(originals[0].toPath()),"UTF-8"));
    }
}
