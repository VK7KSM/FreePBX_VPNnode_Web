package net.elfradio.elfremote;

import android.content.Context;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.SystemClock;
import android.telephony.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.*;

/** 只采集无线定位所需接入点和小区参数；不采集SSID、设备MAC、IMSI或账号。 */
public final class RadioLocation {
    static final long RADIO_AGE_MS = 120000L;

    static boolean usableMac(String value) {
        if (value == null || !value.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}")) return false;
        String mac=value.toLowerCase(Locale.US);
        return (Integer.parseInt(mac.substring(0,2),16)&3)==0 && !mac.equals("00:00:00:00:00:00") && !mac.startsWith("00:00:5e:");
    }
    static boolean recent(long atNanos,long nowNanos) {
        return atNanos>0 && nowNanos>=atNanos && nowNanos-atNanos<=RADIO_AGE_MS*1000000L;
    }
    static boolean usableCellObservation(long atNanos,long nowNanos,boolean registered) {
        // D22的MTK接口对当前注册小区返回零时间戳；仅此情况接受本次读取。
        // 邻区仍须有新鲜时间戳，真实过期或未来时间戳不能冒充当前观测。
        return (atNanos==0 && registered) || recent(atNanos,nowNanos);
    }
    static JSONObject tower(String type,int id,int area,int mcc,int mnc,int strength)throws Exception {
        long max=type.equals("gsm")?65535:268435455;
        if(id<0||id>max||area<0||area>65535||mcc<1||mcc>999||mnc<0||mnc>999)return null;
        JSONObject row=new JSONObject().put("cellId",id).put("locationAreaCode",area).put("mobileCountryCode",mcc).put("mobileNetworkCode",mnc);
        if(strength>=-150&&strength<0)row.put("signalStrength",strength);
        return row;
    }

    static JSONObject capture(Context context) {
        try {
            JSONObject value=collect(context,false);
            if(value.optJSONArray("wifiAccessPoints").length()>=2 || value.optJSONArray("cellTowers").length()>0)return value;
            // 复用已就绪的独立维护核心，不在上报过程中弹出新的su授权。
            JSONObject fromCore=CoreClient.request("/radio-snapshot",new JSONObject(),9000);
            return fromCore==null?value:fromCore;
        } catch(Exception error){RuntimeLog.error("radio_location_unavailable",error);return null;}
    }

    static JSONObject coreCapture() throws Exception {
            ProcessBuilder builder=new ProcessBuilder("app_process","/system/bin","net.elfradio.elfremote.RadioLocation").redirectErrorStream(true);
            builder.environment().put("CLASSPATH",System.getProperty("java.class.path"));
            Process process=builder.start();
            try {
                long until=SystemClock.elapsedRealtime()+8000L;
                java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
                byte[] buffer=new byte[1024];boolean done=false;
                while(SystemClock.elapsedRealtime()<until){
                    while(process.getInputStream().available()>0){int n=process.getInputStream().read(buffer);if(n<0)break;if(bytes.size()+n>16384)throw new java.io.IOException("radio-output-too-large");bytes.write(buffer,0,n);}
                    try{process.exitValue();done=true;break;}catch(IllegalThreadStateException running){SystemClock.sleep(30);}
                }
                if(done && process.exitValue()==0){
                    while(process.getInputStream().available()>0){int n=process.getInputStream().read(buffer);if(n<0)break;if(bytes.size()+n>16384)break;bytes.write(buffer,0,n);}
                    String[] lines=new String(bytes.toByteArray(),"UTF-8").split("\n");
                    for(int i=lines.length-1;i>=0;i--)if(lines[i].startsWith("{"))return new JSONObject(lines[i]);
                }
            } finally {process.destroy();process.getInputStream().close();process.getOutputStream().close();}
            throw new java.io.IOException("radio-capture-unavailable");
    }

    private static JSONArray accessPoints(WifiManager wifi)throws Exception {
        JSONArray array=new JSONArray();if(wifi==null)return array;
        List<ScanResult> scans=wifi.getScanResults();if(scans==null)return array;
        scans=new ArrayList<>(scans);scans.sort((a,b)->Integer.compare(b.level,a.level));
        Set<String> seen=new HashSet<>();long now=SystemClock.elapsedRealtimeNanos();
        for(ScanResult scan:scans){
            if(!usableMac(scan.BSSID)||!recent(scan.timestamp*1000L,now)||scan.level>=0||scan.level < -127)continue;
            String mac=scan.BSSID.toLowerCase(Locale.US);if(!seen.add(mac))continue;
            array.put(new JSONObject().put("macAddress",mac).put("signalStrength",scan.level));
            if(array.length()==6)break;
        }
        return array;
    }

    private static JSONObject collect(Context context,boolean refresh)throws Exception {
        JSONObject value=new JSONObject();JSONArray wifiRows=new JSONArray(),cells=new JSONArray();
        WifiManager wifi=(WifiManager)context.getSystemService(Context.WIFI_SERVICE);
        try {
            wifiRows=accessPoints(wifi);
            if(refresh&&wifiRows.length()<2&&wifi!=null&&wifi.isWifiEnabled()&&wifi.startScan()){
                for(int i=0;i<6&&wifiRows.length()<2;i++){SystemClock.sleep(500);wifiRows=accessPoints(wifi);}
            }
        }catch(Exception unavailable){value.put("wifi_error",unavailable.getClass().getSimpleName());}
        try {
            TelephonyManager phone=(TelephonyManager)context.getSystemService(Context.TELEPHONY_SERVICE);
            List<CellInfo> info=phone==null?null:phone.getAllCellInfo();
            if(info!=null){
                info=new ArrayList<>(info);info.sort((a,b)->Boolean.compare(b.isRegistered(),a.isRegistered()));
                String selected="";
                for(CellInfo cell:info){
                    if(!usableCellObservation(cell.getTimeStamp(),SystemClock.elapsedRealtimeNanos(),cell.isRegistered()))continue;
                    JSONObject row=null;String type="";
                    if(cell instanceof CellInfoLte){CellInfoLte c=(CellInfoLte)cell;CellIdentityLte d=c.getCellIdentity();type="lte";row=tower(type,d.getCi(),d.getTac(),d.getMcc(),d.getMnc(),c.getCellSignalStrength().getDbm());}
                    else if(cell instanceof CellInfoWcdma){CellInfoWcdma c=(CellInfoWcdma)cell;CellIdentityWcdma d=c.getCellIdentity();type="wcdma";row=tower(type,d.getCid(),d.getLac(),d.getMcc(),d.getMnc(),c.getCellSignalStrength().getDbm());}
                    else if(cell instanceof CellInfoGsm){CellInfoGsm c=(CellInfoGsm)cell;CellIdentityGsm d=c.getCellIdentity();type="gsm";row=tower(type,d.getCid(),d.getLac(),d.getMcc(),d.getMnc(),c.getCellSignalStrength().getDbm());}
                    if(row==null||(!selected.isEmpty()&&!selected.equals(type)))continue;
                    selected=type;cells.put(row);if(cells.length()==4)break;
                }
                if(!selected.isEmpty())value.put("radioType",selected);
            }
        }catch(Exception unavailable){value.put("cell_error",unavailable.getClass().getSimpleName());}
        value.put("sampled_at_ms",System.currentTimeMillis()).put("wifiAccessPoints",wifiRows).put("cellTowers",cells);
        return value;
    }

    public static void main(String[] args) {
        try {
            if(android.os.Process.myUid()!=0)System.exit(2);
            // D22按调用UID检查扫描定位权限；系统Context对应UID1000，不能用UID0冒用。
            // 仅降权本次只读子进程，独立维护核心仍保持原身份。
            android.system.Os.setgid(1000);android.system.Os.setuid(1000);
            System.out.println(collect(CoreWake.systemContext(),true));System.exit(0);
        }
        catch(Throwable unavailable){System.exit(1);}
    }
    private RadioLocation() {}
}
