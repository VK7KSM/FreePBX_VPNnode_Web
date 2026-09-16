package org.onetwoone.gateway.remote;

import android.system.Os;
import android.system.StructStat;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Bounded read-only health snapshot for Pixel-specific root dependencies. */
final class GatewayPixelRuntimeHealth {
    interface Properties { String get(String key)throws Exception; }
    interface Node { JSONObject inspect(File file)throws Exception; }
    static JSONObject snapshot()throws Exception{return snapshot(new File("/"),GatewayPixelRuntimeHealth::getprop,GatewayPixelRuntimeHealth::node);}
    static JSONObject snapshot(File root,Properties properties,Node nodes)throws Exception {
        String device=properties.get("ro.product.device"),fingerprint=properties.get("ro.build.fingerprint");
        boolean supported="crosshatch".equals(device)&&"google/crosshatch/crosshatch:12/SP1A.210812.016.B2/8602260:user/release-keys".equals(fingerprint);
        JSONObject power=new JSONObject().put("capacity",integer(root,"sys/class/power_supply/maxfg/capacity",0,100))
                .put("temperature_decic",integer(root,"sys/class/power_supply/battery/temp",-500,1500))
                .put("charge_disabled",binary(root,"sys/class/power_supply/battery/charge_disable"))
                .put("usb_online",binary(root,"sys/class/power_supply/usb/online")).put("pc_online",binary(root,"sys/class/power_supply/pc_port/online"));
        JSONObject audio=new JSONObject().put("control",nodes.inspect(path(root,"dev/snd/controlC0")))
                .put("capture",nodes.inspect(path(root,"dev/snd/pcmC0D0c"))).put("playback",nodes.inspect(path(root,"dev/snd/pcmC0D27p")));
        JSONObject adb=new JSONObject().put("service_port",port(properties.get("service.adb.tcp.port")))
                .put("persistent_port",port(properties.get("persist.adb.tcp.port"))).put("rsa_required","1".equals(properties.get("ro.adb.secure")));
        return new JSONObject().put("schema_version",1).put("supported_build",supported).put("selinux_enforcing",binary(root,"sys/fs/selinux/enforce"))
                .put("power",power).put("audio",audio).put("adb",adb).put("write_locked",true);
    }
    private static Object integer(File root,String relative,int minimum,int maximum){try{int value=Integer.parseInt(read(path(root,relative),32).trim());return value>=minimum&&value<=maximum?value:JSONObject.NULL;}catch(Exception ignored){return JSONObject.NULL;}}
    private static Object binary(File root,String relative){Object value=integer(root,relative,0,1);return value==JSONObject.NULL?JSONObject.NULL:((Integer)value)==1;}
    private static Object port(String value){try{int parsed=Integer.parseInt(value==null?"":value.trim());return parsed>=1&&parsed<=65535?parsed:JSONObject.NULL;}catch(Exception ignored){return JSONObject.NULL;}}
    private static File path(File root,String relative){return new File(root,relative.replace('/',File.separatorChar));}
    private static String read(File file,int maximum)throws Exception {if(!file.isFile()||file.length()>maximum)throw new IOException("health source unavailable");byte[] bytes=new byte[(int)file.length()];try(InputStream input=new FileInputStream(file)){int at=0,n;while(at<bytes.length&&(n=input.read(bytes,at,bytes.length-at))>0)at+=n;if(at!=bytes.length)throw new EOFException();}return new String(bytes,StandardCharsets.US_ASCII);}
    private static String getprop(String key)throws Exception {Process process=new ProcessBuilder("/system/bin/getprop",key).redirectErrorStream(true).start();if(!process.waitFor(2,java.util.concurrent.TimeUnit.SECONDS)){process.destroyForcibly();throw new IOException("property timeout");}try(BufferedReader reader=new BufferedReader(new InputStreamReader(process.getInputStream(),StandardCharsets.UTF_8))){String value=reader.readLine();return value==null?"":value.trim();}}
    private static JSONObject node(File file)throws Exception {JSONObject result=new JSONObject().put("present",file.exists());if(!file.exists())return result.put("uid",JSONObject.NULL).put("gid",JSONObject.NULL).put("mode",JSONObject.NULL).put("context",JSONObject.NULL);StructStat stat=Os.stat(file.getPath());String context=context(file);return result.put("uid",stat.st_uid).put("gid",stat.st_gid).put("mode",stat.st_mode&0777).put("context",context.isEmpty()?JSONObject.NULL:bounded(context));}
    private static String context(File file)throws Exception {Process process=new ProcessBuilder("/system/bin/ls","-Zd",file.getPath()).redirectErrorStream(true).start();if(!process.waitFor(2,java.util.concurrent.TimeUnit.SECONDS)){process.destroyForcibly();return "";}try(BufferedReader reader=new BufferedReader(new InputStreamReader(process.getInputStream(),StandardCharsets.UTF_8))){String line=reader.readLine();if(process.exitValue()!=0||line==null)return "";int split=line.indexOf(' ');return split>0?line.substring(0,split):"";}}
    private static String bounded(String value){return value.length()<=128?value:value.substring(0,128);}
    private GatewayPixelRuntimeHealth(){}
}
