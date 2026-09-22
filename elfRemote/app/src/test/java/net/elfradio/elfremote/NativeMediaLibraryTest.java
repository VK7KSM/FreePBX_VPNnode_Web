package net.elfradio.elfremote;
import org.junit.Test;import static org.junit.Assert.*;import java.nio.file.*;import java.security.MessageDigest;
import org.json.JSONObject;

public class NativeMediaLibraryTest {
 private static String sha(byte[] bytes)throws Exception{
  return NativeMediaLibrary.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
 }

 @Test public void processAbiAndPersistedLibraryMustMatchTheInstalledApk()throws Exception{
  assertEquals("lib/arm64-v8a/libjingle_peerconnection_so.so",NativeMediaLibrary.entry(true));
  assertEquals("lib/armeabi-v7a/libjingle_peerconnection_so.so",NativeMediaLibrary.entry(false));
  Path p=Files.createTempFile("media-native-test",".so");
  try{
   byte[] bytes={1,2,3,4};Files.write(p,bytes);String digest=sha(bytes);
   assertTrue(NativeMediaLibrary.matches(p.toFile(),4,digest));
   assertFalse("长度对不上就不能用",NativeMediaLibrary.matches(p.toFile(),5,digest));
   // 换成 CRC 相同、内容不同的文件也必须被拒；原来用 CRC 校验，
   // 对「下载被中途替换」这种情况是拦不住的，改成 SHA-256 正是为此。
   Files.write(p,new byte[]{4,3,2,1});
   assertFalse("内容变了就不能用",NativeMediaLibrary.matches(p.toFile(),4,digest));
  }finally{Files.deleteIfExists(p);}
 }

 /** 源码级别是 Java 8，没有 String.repeat；自己拼一个合法的 64 位十六进制。 */
 private static String hexOf(int fill){
  StringBuilder text=new StringBuilder();
  while(text.length()<64)text.append(Integer.toHexString(fill&0xff));
  return text.substring(0,64);
 }

 private static JSONObject identity(String digest,long size)throws Exception{
  return new JSONObject().put("abi","arm64-v8a").put("name",NativeMediaLibrary.LIB)
    .put("size",size).put("sha256",digest);
 }
 private static JSONObject offer(String digest,long size,String url)throws Exception{
  return new JSONObject().put("ok",true).put("sha256",digest).put("size",size).put("url",url);
 }
 private static final String BASE="https://v.elfradio.net";
 private static final String URL=BASE+"/api/elfremote/apk/d22-media-native-1-abcdef123456";

 @Test public void offerIsAcceptedOnlyWhenItNamesExactlyTheLibraryThisPackageWants()throws Exception{
  String digest=hexOf(0xaa);
  JSONObject want=identity(digest,12094648L);
  assertNotNull(MediaNativeManifest.accept(offer(digest,12094648L,URL),want,BASE));
 }

 @Test public void offerForADifferentLibraryIsRefusedBeforeAnyDownloadStarts()throws Exception{
  JSONObject want=identity(hexOf(0xaa),12094648L);
  // 哈希不符时下载回来也会被丢掉，这里提前拒是为了不白下 12 MB。
  assertNull(MediaNativeManifest.accept(offer(hexOf(0xbb),12094648L,URL),want,BASE));
  assertNull(MediaNativeManifest.accept(offer(hexOf(0xaa),999L,URL),want,BASE));
 }

 @Test public void offerMustPointAtOurOwnControlHostOverHttps()throws Exception{
  String digest=hexOf(0xaa);JSONObject want=identity(digest,12094648L);
  // 哈希校验拦得住伪造的库，但拦不住「服务端指使设备去连任意地址」这件事本身。
  assertNull("不能被指到别的主机",
    MediaNativeManifest.accept(offer(digest,12094648L,"https://evil.example.com/lib.so"),want,BASE));
  assertNull("不能降级到明文",
    MediaNativeManifest.accept(offer(digest,12094648L,"http://v.elfradio.net/lib.so"),want,BASE));
 }

 @Test public void failedOrMalformedOffersYieldNothing()throws Exception{
  String digest=hexOf(0xaa);JSONObject want=identity(digest,12094648L);
  assertNull(MediaNativeManifest.accept(new JSONObject().put("ok",false).put("msg","服务端尚未发布该原生库"),want,BASE));
  assertNull(MediaNativeManifest.accept(new JSONObject(),want,BASE));
  assertNull(MediaNativeManifest.accept(null,want,BASE));
 }
}
