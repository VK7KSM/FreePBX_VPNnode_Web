package net.elfradio.elfremote;
import org.junit.Test;import static org.junit.Assert.*;
public class HttpRetryPolicyTest {
 @Test public void outageIsBoundedAndEndpointsRemainIndependent()throws Exception {
  HttpRetryPolicy p=new HttpRetryPolicy();String report="https://v.elfradio.net/api/devices/report",sync="https://v.elfradio.net/api/devices/push-sync";long now=1000;
  for(long expected:new long[]{60000,120000,240000,480000,900000,900000}){
   p.check(report,now);assertEquals(expected,p.failed(report,new HttpRetryPolicy.StatusFailure(500,null),now));
   final long before=now+expected-1;assertThrows(Exception.class,()->p.check(report,before));p.check(sync,now);now+=expected;
  }
  p.success(report);p.check(report,now);assertEquals(60000,p.failed(report,new java.io.IOException("network"),now));
 }
 @Test public void serverRetryAfterAndRepeatedLocalChecksDoNotExtendWait()throws Exception {
  HttpRetryPolicy p=new HttpRetryPolicy();String url="https://v.elfradio.net/api/devices/push-sync";
  assertEquals(900000,p.failed(url,new HttpRetryPolicy.StatusFailure(503,"999999999"),100));
  for(int i=0;i<30;i++)assertThrows(Exception.class,()->p.check(url,200));
  assertEquals(899900,p.remaining(url,200));p.check(url,900100);
  assertEquals(0,p.failed(url,new HttpRetryPolicy.StatusFailure(401,null),900100));p.check(url,900100);
 }
 @Test public void queryVariationDoesNotBypassCooldown()throws Exception {
  HttpRetryPolicy p=new HttpRetryPolicy();p.failed("https://v.elfradio.net/api/devices/enroll-status?a=1",new HttpRetryPolicy.StatusFailure(429,"invalid"),0);
  assertThrows(Exception.class,()->p.check("https://v.elfradio.net/api/devices/enroll-status?a=2",1));
 }
}
