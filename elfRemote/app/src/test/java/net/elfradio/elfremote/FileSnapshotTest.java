package net.elfradio.elfremote;
import org.json.JSONObject;import org.junit.Test;import static org.junit.Assert.*;import java.io.*;import java.nio.file.*;
public class FileSnapshotTest{
 private void clean(Path dir)throws Exception{try(java.util.stream.Stream<Path> p=Files.walk(dir)){for(Path f:p.sorted(java.util.Comparator.reverseOrder()).toArray(Path[]::new))Files.delete(f);}}
 @Test public void immutableCopyRecoveryAndCancellationPreserveSource()throws Exception{
  Path dir=Files.createTempDirectory("snapshot");try{
   File source=dir.resolve("original.bin").toFile(),target=dir.resolve("copy.bin").toFile(),job=dir.resolve("job").toFile();job.mkdir();Files.write(source.toPath(),new byte[]{1,2,3});
   JSONObject p=new JSONObject().put("source",source.getPath()).put("target",target.getPath()).put("uid",0),r=FileSnapshot.run(job,p);assertEquals("snapshot",r.getString("action"));assertEquals(RescueFiles.sha256(source),r.getString("sha256"));
   Files.write(source.toPath(),new byte[]{9});assertArrayEquals(new byte[]{1,2,3},Files.readAllBytes(target.toPath()));assertNotNull(FileSnapshot.recover(job));
   Files.write(target.toPath(),new byte[]{4});assertNull(FileSnapshot.recover(job));target.delete();new File(job,"cancel").createNewFile();
   try{FileSnapshot.run(job,p);fail();}catch(IOException expected){}assertArrayEquals(new byte[]{9},Files.readAllBytes(source.toPath()));assertFalse(target.exists());assertFalse(new File(target.getPath()+".tmp").exists());
  }finally{clean(dir);}
 }
 @Test public void oversizedSparseFileRejectedBeforeCopy()throws Exception{
  Path dir=Files.createTempDirectory("snapshot-size");try{File source=dir.resolve("large").toFile();try(RandomAccessFile f=new RandomAccessFile(source,"rw")){f.setLength(FileCommit.MAX_BYTES+1);}
   try{FileSnapshot.run(dir.toFile(),new JSONObject().put("source",source.getPath()).put("target",dir.resolve("copy").toString()));fail();}catch(IOException expected){}assertFalse(Files.exists(dir.resolve("copy")));
  }finally{clean(dir);}
 }
}
