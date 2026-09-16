package org.onetwoone.gateway.remote;

import android.content.Context;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Looper;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Narrow root helper for Wi-Fi configuration. It never accepts shell commands. */
public final class GatewayWifiRootMain {
    public static void main(String[] args) {
        try {
            if(android.os.Process.myUid()!=0)throw new SecurityException("root required");
            if(args.length==1&&"check".equals(args[0])){wifi().getConfiguredNetworks();System.out.println("WIFI_API_READY");return;}
            if(args.length!=2||!java.util.Arrays.asList("prepare","apply","restore","commit").contains(args[0]))
                throw new IllegalArgumentException("invalid operation");
            File dir=directory(args[1]);JSONObject result;
            if("prepare".equals(args[0]))result=prepare(dir);
            else if("apply".equals(args[0]))result=apply(dir);
            else if("restore".equals(args[0]))result=restore(dir);
            else result=commit(dir);
            System.out.println("WIFI_RESULT_HEX="+encodeResult(result));System.out.println("WIFI_OPERATION_OK");
        } catch(Throwable error) {System.err.println("WIFI_OPERATION_FAILED");System.exit(1);}
    }

    private static File directory(String value) throws Exception {
        File dir=new File(value).getCanonicalFile();String path=dir.getPath().replace('\\','/');
        if(!path.matches("/data/(?:user/0|data)/org\\.onetwoone\\.gateway/files/gateway-wifi/[0-9a-f]{64}"))
            throw new SecurityException("invalid transaction path");
        if(!dir.isDirectory())throw new IllegalArgumentException("transaction missing");return dir;
    }

    private static Context context() throws Exception {
        if(Looper.getMainLooper()==null)Looper.prepareMainLooper();
        Object thread=Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
        return (Context)thread.getClass().getMethod("getSystemContext").invoke(thread);
    }
    private static WifiManager wifi() throws Exception {
        WifiManager value=(WifiManager)context().getSystemService(Context.WIFI_SERVICE);
        if(value==null||!value.isWifiEnabled())throw new IllegalStateException("wifi unavailable");return value;
    }
    private static JSONObject prepare(File dir) throws Exception {
        WifiManager wifi=wifi();JSONObject request=read(new File(dir,"request.json"));GatewayWifiPolicy.connectParams(request);
        WifiInfo current=wifi.getConnectionInfo();
        if(current==null||current.getNetworkId()<0||current.getIpAddress()==0)throw new IllegalStateException("fallback unavailable");
        List<WifiConfiguration> configs=wifi.getConfiguredNetworks();if(configs==null)throw new IllegalStateException("config unavailable");
        String quoted=GatewayWifiPolicy.quoteWifi(request.getString("ssid"));int target=-1;JSONArray enabled=new JSONArray();
        for(WifiConfiguration config:configs){if(quoted.equals(config.SSID))target=config.networkId;if(config.status!=WifiConfiguration.Status.DISABLED)enabled.put(config.networkId);}
        if(target>=0&&!request.getString("password").isEmpty())throw new IllegalArgumentException("saved network requires empty password");
        return new JSONObject().put("ok",true).put("old",current.getNetworkId()).put("target",target)
                .put("created",target<0).put("ssid",request.getString("ssid")).put("enabled",enabled);
    }
    private static JSONObject apply(File dir) throws Exception {
        WifiManager wifi=wifi();JSONObject request=read(new File(dir,"request.json")),state=read(new File(dir,"state.json"));
        GatewayWifiPolicy.connectParams(request);validateState(state,request);
        int target=state.getInt("target");
        if(target<0){
            WifiConfiguration config=new WifiConfiguration();config.SSID=GatewayWifiPolicy.quoteWifi(request.getString("ssid"));
            String password=request.getString("password");
            if(password.isEmpty())config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            else {config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);config.preSharedKey=password.matches("[0-9a-fA-F]{64}")?password:GatewayWifiPolicy.quoteWifi(password);}
            target=wifi.addNetwork(config);if(target<0)throw new IllegalStateException("add rejected");wifi.saveConfiguration();
        }
        if(!wifi.enableNetwork(target,true)||!wifi.reconnect())throw new IllegalStateException("connect rejected");
        return new JSONObject().put("ok",true).put("target",target);
    }
    private static JSONObject restore(File dir) throws Exception {
        WifiManager wifi=wifi();JSONObject state=read(new File(dir,"state.json"));validateState(state,null);
        if(state.getBoolean("created")){
            String quoted=GatewayWifiPolicy.quoteWifi(state.getString("ssid"));List<WifiConfiguration> configs=wifi.getConfiguredNetworks();
            if(configs==null)throw new IllegalStateException("config unavailable");
            for(WifiConfiguration config:configs)if((state.getInt("target")>=0&&config.networkId==state.getInt("target"))||quoted.equals(config.SSID))wifi.removeNetwork(config.networkId);
            wifi.saveConfiguration();
        }
        if(!wifi.enableNetwork(state.getInt("old"),true))throw new IllegalStateException("restore rejected");
        restoreEnabled(wifi,state.getJSONArray("enabled"));if(!wifi.reconnect())throw new IllegalStateException("reconnect rejected");
        return new JSONObject().put("ok",true).put("restored",true).put("network_id",state.getInt("old"));
    }
    private static JSONObject commit(File dir) throws Exception {
        WifiManager wifi=wifi();JSONObject state=read(new File(dir,"state.json"));validateState(state,null);
        restoreEnabled(wifi,state.getJSONArray("enabled"));return new JSONObject().put("ok",true).put("committed",true);
    }
    private static void restoreEnabled(WifiManager wifi,JSONArray enabled) throws Exception {
        for(int i=0;i<enabled.length();i++)wifi.enableNetwork(enabled.getInt(i),false);
    }
    private static void validateState(JSONObject state,JSONObject request) throws Exception {
        if(state.length()!=6||!state.has("task")||!state.has("old")||!state.has("target")||!state.has("created")||!state.has("ssid")||!state.has("enabled")
                ||!state.getString("task").matches("[A-Za-z0-9-]{1,96}")||state.getInt("old")<0||state.getInt("target")< -1
                ||state.getBoolean("created")!=(state.getInt("target")<0)||state.getString("ssid").isEmpty())throw new IllegalArgumentException("invalid state");
        JSONArray enabled=state.getJSONArray("enabled");for(int i=0;i<enabled.length();i++)if(enabled.getInt(i)<0)throw new IllegalArgumentException("invalid state");
        if(request!=null&&!state.getString("ssid").equals(request.getString("ssid")))throw new IllegalArgumentException("state mismatch");
    }
    private static JSONObject read(File file) throws Exception {
        if(!file.isFile()||file.length()<2||file.length()>8192)throw new IllegalArgumentException("invalid file");
        byte[] bytes=new byte[(int)file.length()];try(FileInputStream in=new FileInputStream(file)){int at=0,n;while(at<bytes.length&&(n=in.read(bytes,at,bytes.length-at))>0)at+=n;if(at!=bytes.length)throw new IllegalArgumentException("short read");}
        return new JSONObject(new String(bytes,StandardCharsets.UTF_8));
    }
    static String encodeResult(JSONObject value) {
        byte[] bytes=value.toString().getBytes(StandardCharsets.UTF_8);StringBuilder encoded=new StringBuilder(bytes.length*2);
        for(byte item:bytes)encoded.append(String.format(java.util.Locale.ROOT,"%02x",item&0xff));
        return encoded.toString();
    }
    private GatewayWifiRootMain() {}
}
