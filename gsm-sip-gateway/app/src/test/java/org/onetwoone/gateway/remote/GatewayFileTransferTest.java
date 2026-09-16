package org.onetwoone.gateway.remote;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayFileTransferTest {
    @Rule public TemporaryFolder temp=new TemporaryFolder();

    @Test public void profileOnlyOpensImplementedFileCapabilities()throws Exception {
        JSONObject profile=GatewayRemotePolicy.profile();
        assertTrue(profile.getBoolean("managed_file_operations"));
        assertTrue(profile.getBoolean("managed_file_tasks"));
        assertTrue(profile.getBoolean("managed_file_return"));
        assertFalse(profile.optBoolean("managed_contacts_page_v1"));
    }

    @Test public void commitPreservesTargetUntilVerified()throws Exception {
        File task=temp.newFolder("task"),source=temp.newFile("source"),target=temp.newFile("target");
        Files.write(source.toPath(),"new".getBytes("UTF-8"));Files.write(target.toPath(),"old".getBytes("UTF-8"));
        JSONObject params=new JSONObject().put("source",source.getPath()).put("path",target.getPath())
                .put("size",source.length()).put("sha256",hash(source)).put("overwrite",true);
        JSONObject result=GatewayFileCommit.run(task,params);assertEquals("committed",result.getString("action"));
        assertEquals("new",new String(Files.readAllBytes(target.toPath()),"UTF-8"));
        assertEquals("committed",GatewayFileCommit.recover(task).getString("action"));
    }

    @Test public void failedHashNeverReplacesTarget()throws Exception {
        File task=temp.newFolder("bad-task"),source=temp.newFile("bad-source"),target=temp.newFile("bad-target");
        Files.write(source.toPath(),"new".getBytes("UTF-8"));Files.write(target.toPath(),"old".getBytes("UTF-8"));
        JSONObject params=new JSONObject().put("source",source.getPath()).put("path",target.getPath())
                .put("size",source.length()).put("sha256",repeat('0',64)).put("overwrite",true);
        try{GatewayFileCommit.run(task,params);fail();}catch(Exception expected){}
        assertEquals("old",new String(Files.readAllBytes(target.toPath()),"UTF-8"));
    }

    @Test public void snapshotIsImmutableAndSegmentHashSupportsLargeOffsets()throws Exception {
        File task=temp.newFolder("snapshot-task"),source=temp.newFile("snapshot-source"),target=new File(task,"snapshot.bin");
        Files.write(source.toPath(),new byte[]{1,2,3});JSONObject result=GatewayFileSnapshot.run(task,new JSONObject()
                .put("path",source.getPath()).put("target",target.getPath()).put("uid",0));
        assertEquals("snapshot",result.getString("action"));Files.write(source.toPath(),new byte[]{9});assertArrayEquals(new byte[]{1,2,3},Files.readAllBytes(target.toPath()));
        File sparse=temp.newFile("sparse");try(RandomAccessFile file=new RandomAccessFile(sparse,"rw")){long start=2147483650L;file.seek(start);file.write(new byte[]{4,5,6});
            assertEquals(GatewayFileCommit.hex(java.security.MessageDigest.getInstance("SHA-256").digest(new byte[]{4,5,6})),GatewayManagedTransferTasks.segmentHash(file,start,3));}
    }

    @Test public void stoppedDownloadPrefersCancellationAndExpiry()throws Exception {
        File task=temp.newFolder("stopped-task");JSONObject live=new JSONObject().put("expires_at",2000L);
        assertNull(GatewayManagedTransferTasks.stoppedReason(live,task,1000L));
        assertEquals("expired",GatewayManagedTransferTasks.stoppedReason(live,task,2000L));
        assertTrue(new File(task,"cancel").createNewFile());
        assertEquals("cancelled",GatewayManagedTransferTasks.stoppedReason(live,task,3000L));
        assertEquals("cancelled",GatewayManagedTransferTasks.stoppedReason(new JSONObject().put("cancel_requested",true).put("expires_at",4000L),temp.newFolder("server-cancel"),1000L));
    }

    private static String hash(File file)throws Exception {return GatewayFileCommit.hex(java.security.MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file.toPath())));}
    private static String repeat(char value,int count){char[] chars=new char[count];java.util.Arrays.fill(chars,value);return new String(chars);}
}
