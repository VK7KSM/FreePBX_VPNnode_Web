package net.elfradio.elfremote;
import java.io.*;import java.net.*;import java.security.Principal;import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;

/** 在独立诊断进程内注入HTTP响应，不访问网络、不改生产配置或系统时钟。 */
public final class HttpRetryProbe {
    static int opened,status=503;
    static final class Fake extends HttpsURLConnection {
        Fake(URL url){super(url);opened++;}
        public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
        public int getResponseCode(){return status;}public String getHeaderField(String name){return "Retry-After".equals(name)?"900":null;}
        public OutputStream getOutputStream(){return new ByteArrayOutputStream();}
        public InputStream getInputStream(){return new ByteArrayInputStream("{\"ok\":true}".getBytes());}
        public String getCipherSuite(){return "fixture";}public Certificate[] getLocalCertificates(){return null;}
        public Certificate[] getServerCertificates(){return null;}public Principal getPeerPrincipal(){return null;}public Principal getLocalPrincipal(){return null;}
    }
    static void require(boolean pass)throws Exception{if(!pass)throw new Exception("验收断言失败");}
    public static void main(String[] args)throws Exception {
        URL.setURLStreamHandlerFactory(new URLStreamHandlerFactory(){public URLStreamHandler createURLStreamHandler(String protocol){return "https".equals(protocol)?new URLStreamHandler(){protected URLConnection openConnection(URL url){return new Fake(url);}}:null;}});
        String report="https://v.elfradio.net/api/devices/report";
        try{HttpJson.post(report,"{}");throw new Exception("未拒绝503");}catch(HttpRetryPolicy.StatusFailure expected){require(expected.status==503);}
        require(opened==1);
        for(int i=0;i<20;i++)try{HttpJson.post(report,"{}");throw new Exception("未执行退避");}catch(IOException expected){}
        require(opened==1);status=200;require(HttpJson.post("https://v.elfradio.net/api/devices/push-sync","{}").contains("true"));require(opened==2);
        HttpRetryPolicy policy=new HttpRetryPolicy();long now=1000;
        for(long delay:new long[]{60000,120000,240000,480000,900000,900000}){
            policy.check(report,now);require(policy.failed(report,new HttpRetryPolicy.StatusFailure(500,null),now)==delay);
            try{policy.check(report,now+delay-1);throw new Exception("提前联网");}catch(IOException expected){}
            now+=delay;
        }
        policy.success(report);policy.check(report,now);
        System.out.println("HTTP_503_RETRY_AFTER_OK LOCAL_RETRIES_NO_NETWORK=20 ENDPOINT_ISOLATION_OK EXPONENTIAL_CAP_15MIN_OK RECOVERY_RESET_OK");
    }
}
