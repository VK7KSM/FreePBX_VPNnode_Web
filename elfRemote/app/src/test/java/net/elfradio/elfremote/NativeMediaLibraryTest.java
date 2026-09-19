package net.elfradio.elfremote;
import org.junit.Test;import static org.junit.Assert.*;import java.nio.file.*;import java.util.zip.CRC32;
public class NativeMediaLibraryTest {
 @Test public void processAbiAndCachedLibraryMustMatchTheInstalledApk()throws Exception{
  assertEquals("lib/arm64-v8a/libjingle_peerconnection_so.so",NativeMediaLibrary.entry(true));
  assertEquals("lib/armeabi-v7a/libjingle_peerconnection_so.so",NativeMediaLibrary.entry(false));
  Path p=Files.createTempFile("media-native-test",".so");try{byte[] bytes={1,2,3,4};Files.write(p,bytes);CRC32 crc=new CRC32();crc.update(bytes);
   assertTrue(NativeMediaLibrary.matches(p.toFile(),4,crc.getValue()));assertFalse(NativeMediaLibrary.matches(p.toFile(),5,crc.getValue()));
   Files.write(p,new byte[]{4,3,2,1});assertFalse(NativeMediaLibrary.matches(p.toFile(),4,crc.getValue()));
  }finally{Files.deleteIfExists(p);}
 }
}
