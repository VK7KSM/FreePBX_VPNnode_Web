package net.elfradio.elfremote;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.net.NetworkInterface;
import java.util.Enumeration;

/** 按需实读，不依赖主应用、Android Context或云连接。 */
final class RescueDiagnostics {
    static JSONObject collect() throws Exception {
        JSONObject result=new JSONObject().put("sampled_at_ms",System.currentTimeMillis())
                .put("core_version",BuildConfig.VERSION_CODE);
        try{result.put("elapsed_ms",android.os.SystemClock.elapsedRealtime()).put("awake_ms",android.os.SystemClock.uptimeMillis());}
        catch(RuntimeException unavailable){result.put("elapsed_ms",JSONObject.NULL).put("awake_ms",JSONObject.NULL);}
        JSONObject properties=new JSONObject();
        for(String key:new String[]{"ro.product.model","ro.product.manufacturer","ro.product.device",
                "ro.build.version.release","ro.build.version.sdk","ro.build.version.security_patch",
                "ro.build.fingerprint","ro.product.cpu.abilist","sys.boot_completed",
                "init.svc.bootanim","init.svc.adbd","service.adb.tcp.port","persist.adb.tcp.port",
                "sys.usb.state","persist.sys.timezone"}){
            try{String value=(String)Class.forName("android.os.SystemProperties").getMethod("get",String.class).invoke(null,key);
                properties.put(key,value.isEmpty()?JSONObject.NULL:value);
            }catch(Exception unavailable){properties.put(key,JSONObject.NULL);}
        }
        result.put("properties",properties);
        result.put("uptime",read("/proc/uptime",1024));
        result.put("kernel",read("/proc/version",4096));
        result.put("selinux",read("/sys/fs/selinux/enforce",64));
        result.put("security_context",read("/proc/self/attr/current",256));
        JSONObject memory=read("/proc/meminfo",16000);
        if(memory.has("text"))memory.put("bytes",memoryBytes(memory.getString("text")));
        result.put("memory",memory);
        JSONArray storage=new JSONArray();
        for(String path:new String[]{"/data","/system","/sdcard"}){
            File file=new File(path);JSONObject item=new JSONObject().put("path",path);
            if(file.isDirectory())item.put("total_bytes",file.getTotalSpace()).put("free_bytes",file.getUsableSpace());
            else item.put("error","目录当前不可用");
            storage.put(item);
        }
        result.put("storage",storage);
        JSONArray interfaces=new JSONArray();
        try{
            Enumeration<NetworkInterface> all=NetworkInterface.getNetworkInterfaces();
            while(all!=null&&all.hasMoreElements()&&interfaces.length()<64){
                NetworkInterface n=all.nextElement();JSONObject item=new JSONObject().put("name",n.getName());
                try{item.put("up",n.isUp()).put("loopback",n.isLoopback()).put("mtu",n.getMTU());
                    JSONArray addresses=new JSONArray();Enumeration<java.net.InetAddress> values=n.getInetAddresses();
                    while(values.hasMoreElements()&&addresses.length()<32)addresses.put(values.nextElement().getHostAddress());
                    item.put("addresses",addresses);
                }catch(Exception unavailable){item.put("error","接口状态暂不可读");}
                interfaces.put(item);
            }
        }catch(Exception unavailable){result.put("network_error","网络接口暂不可读");}
        result.put("interfaces",interfaces).put("ipv4_routes",read("/proc/net/route",32768))
                .put("ipv6_routes",read("/proc/net/ipv6_route",32768));
        return result;
    }

    static JSONObject memoryBytes(String raw)throws Exception{
        JSONObject bytes=new JSONObject();
        for(String line:raw.split("\n")){
            String[] pair=line.trim().split("\\s+");
            if(pair.length!=3||!pair[0].endsWith(":")||!"kB".equals(pair[2]))continue;
            try{long n=Long.parseLong(pair[1]);if(n>=0&&n<=Long.MAX_VALUE/1024)bytes.put(pair[0].substring(0,pair[0].length()-1),n*1024);}
            catch(NumberFormatException invalid){}
        }
        return bytes;
    }

    private static JSONObject read(String path,int limit)throws Exception{
        JSONObject value=new JSONObject().put("source",path);
        try{value.put("text",RescueFiles.read(new File(path),limit).trim());}
        catch(Exception unavailable){value.put("error","当前无法读取");}
        return value;
    }
    private RescueDiagnostics(){}
}
