package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class GatewayArtifactDownloadTest {
    @Rule public TemporaryFolder files=new TemporaryFolder();
    private static final byte[] BYTES=new byte[]{1,2,3,4};
    private String hash() throws Exception {File reference=files.newFile();Files.write(reference.toPath(),BYTES);return GatewayApkVerifier.sha256(reference);}
    private void copy(byte[] bytes,File destination,long size,String sha) throws Exception {
        GatewayArtifactDownload.copyVerified(new ByteArrayInputStream(bytes),destination,size,sha,System.nanoTime()+1_000_000_000L);
    }
    @Test public void commitsVerifiedBytesAndAllowsIdenticalRetry() throws Exception {
        File target=new File(files.newFolder(),"payload.apk");String sha=hash();
        copy(BYTES,target,4,sha);copy(BYTES,target,4,sha);
        assertArrayEquals(BYTES,Files.readAllBytes(target.toPath()));assertEquals(1,target.getParentFile().list().length);
    }
    @Test public void truncationOversizeAndTamperingNeverCommit() throws Exception {
        String sha=hash();
        for(byte[] bytes:new byte[][]{{1,2},{1,2,3,4,5},{4,3,2,1}}) {
            File target=new File(files.newFolder(),"payload.apk");
            try{copy(bytes,target,4,sha);fail("corruption accepted");}catch(SecurityException expected){}
            assertFalse(target.exists());assertEquals(0,target.getParentFile().list().length);
        }
    }
    @Test public void preservesExistingArtifactOnConflict() throws Exception {
        File target=new File(files.newFolder(),"payload.apk");Files.write(target.toPath(),new byte[]{9});
        try{copy(BYTES,target,4,hash());fail("existing file replaced");}catch(SecurityException expected){}
        assertArrayEquals(new byte[]{9},Files.readAllBytes(target.toPath()));
    }
    @Test public void interruptionAndDeadlineCleanPartialFiles() throws Exception {
        File target=new File(files.newFolder(),"payload.apk");String sha=hash();
        InputStream broken=new InputStream(){public int read() throws IOException {throw new IOException("interrupted");}};
        try{GatewayArtifactDownload.copyVerified(broken,target,4,sha,System.nanoTime()+1_000_000_000L);fail();}catch(IOException expected){}
        assertEquals(0,target.getParentFile().list().length);
        try{GatewayArtifactDownload.copyVerified(new ByteArrayInputStream(BYTES),target,4,sha,0);fail();}catch(IOException expected){}
        assertEquals(0,target.getParentFile().list().length);
    }
}
