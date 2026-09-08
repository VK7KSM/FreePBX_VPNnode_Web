package net.elfradio.elfremote;

import android.content.*;
import android.net.*;
import android.net.wifi.*;
import android.os.Handler;
import org.json.*;
import java.io.*;
import java.util.*;

final class WifiConnector {
    interface Done { void finish(boolean ok,String detail); }
    private final WifiManager wifi;
    private final ConnectivityManager cm;
    private final SharedPreferences state;
    private final File guardBase;
    private final String apkPath;
    private File guardDir;
    private final Handler worker;
    private Done done;
    private long deadline;
    private final Runnable poll=this::poll;
    WifiConnector(Context c,Handler worker) {
        wifi=(WifiManager)c.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        cm=(ConnectivityManager)c.getSystemService(Context.CONNECTIVITY_SERVICE);
        state=c.getSharedPreferences("wifi-connect",Context.MODE_PRIVATE);
        apkPath=c.getApplicationInfo().sourceDir;
        guardBase=new File(c.getFilesDir(),"wifi-guard"); this.worker=worker;
    }
    String pendingTask() {return state.getBoolean("active",false)?state.getString("task",""):"";}
    boolean busy() {return done!=null;}
    void recover() {
        if(state.getBoolean("active",false)) {
            guardDir=new File(guardBase,UpdatePolicy.sha256Hex(state.getString("task","").getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            rollback("wifi-interrupted-rolled-back");
        }
    }
    void connect(String task,JSONObject p,Done callback) throws Exception {
        ConfigPolicy.wifi(p);
        if(done!=null) throw new IOException("wifi-busy");
        if(state.getBoolean("active",false) && task.equals(state.getString("task",""))) {done=callback;recover();return;}
        if(task.equals(state.getString("task","")) && !state.getBoolean("active",false)) {
            callback.finish(state.getBoolean("ok",false),state.getString("result","wifi-interrupted"));return;
        }
        if(state.getBoolean("active",false)) recover();
        if(state.getBoolean("active",false)) throw new IOException("wifi-rollback-pending");
        if(wifi==null || !wifi.isWifiEnabled()) throw new IOException("wifi-disabled");
        WifiInfo current=wifi.getConnectionInfo();
        if(current==null || current.getNetworkId()<0 || current.getIpAddress()==0) throw new IOException("wifi-no-fallback-connection");
        List<WifiConfiguration> configs=wifi.getConfiguredNetworks();
        if(configs==null) throw new IOException("wifi-config-unavailable");
        String ssid=ConfigPolicy.quoteWifi(p.getString("ssid")), password=p.optString("password","");
        WifiConfiguration found=null; StringBuilder enabled=new StringBuilder();
        for(WifiConfiguration c:configs) {
            if(ssid.equals(c.SSID)) found=c;
            if(c.status!=WifiConfiguration.Status.DISABLED) enabled.append(c.networkId).append(' ');
        }
        // 已保存网络只复用，不用读取到的掩码密码覆盖原始凭据。
        if(found!=null && !password.isEmpty()) throw new IOException("wifi-saved-use-empty-password");
        int target=found==null?-1:found.networkId;
        if(!state.edit().clear().putString("task",task).putString("ssid",ssid).putInt("old",current.getNetworkId())
                .putInt("target",target).putBoolean("created",found==null).putString("enabled",enabled.toString())
                .putBoolean("active",true).commit()) throw new IOException("wifi-state-unavailable");
        done=callback;
        guardDir=new File(guardBase,UpdatePolicy.sha256Hex(task.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        try {
            if(found==null) {
                WifiConfiguration config=new WifiConfiguration();config.SSID=ssid;
                if(password.isEmpty()) config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
                else {config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);config.preSharedKey=password.matches("[0-9a-fA-F]{64}")?password:ConfigPolicy.quoteWifi(password);}
                target=wifi.addNetwork(config);
                if(target<0) throw new IOException("wifi-add-failed");
                if(!state.edit().putInt("target",target).commit()) throw new IOException("wifi-state-unavailable");
            }
            armGuard(current.getNetworkId(),enabled.toString());
            if(!wifi.enableNetwork(target,true) || !wifi.reconnect()) throw new IOException("wifi-connect-rejected");
            deadline=android.os.SystemClock.elapsedRealtime()+90000L;
            RuntimeLog.event("wifi_connect_start");worker.postDelayed(poll,2000L);
        } catch(Exception error) {rollback("wifi-connect-failed-rolled-back");}
    }
    private void armGuard(int old,String enabled) throws Exception {
        if(!guardDir.isDirectory()&&!guardDir.mkdirs()) throw new IOException("wifi-guard-unavailable");
        File cancel=new File(guardDir,"cancel"), ready=new File(guardDir,"ready");
        if(cancel.exists()&&!cancel.delete()) throw new IOException("wifi-guard-unavailable");
        if(ready.exists()&&!ready.delete()) throw new IOException("wifi-guard-unavailable");
        File script=new File(guardDir,"guard.sh");
        String dir=guardDir.getAbsolutePath();
        String shell=guardScript(dir,apkPath,old,enabled);
        try(FileOutputStream out=new FileOutputStream(script)){out.write(shell.getBytes(java.nio.charset.StandardCharsets.UTF_8));out.getFD().sync();}
        Process process=new ProcessBuilder("su","-c","sh "+script.getAbsolutePath()+" </dev/null >/dev/null 2>&1 &").start();
        long until=android.os.SystemClock.elapsedRealtime()+5000;
        while(!ready.exists() && android.os.SystemClock.elapsedRealtime()<until) Thread.sleep(50);
        process.getInputStream().close();process.getErrorStream().close();process.getOutputStream().close();
        if(!ready.exists()) throw new IOException("wifi-guard-not-ready");
    }
    static String guardScript(String dir,String apk,int old,String enabled) {
        if(old<0 || !enabled.matches("[0-9 ]*")) throw new IllegalArgumentException("wifi-guard-invalid");
        return "#!/system/bin/sh\nset -e\nexport CLASSPATH="+shellPath(apk)+"\n"
                +"app_process /system/bin net.elfradio.elfremote.WifiRollbackMain check | grep -q WIFI_API_READY\necho ready > "+shellPath(dir+"/ready")+"\n"
                +"i=0\nwhile [ $i -lt 120 ]; do [ ! -f "+shellPath(dir+"/cancel")+" ] || exit 0; sleep 1; i=$((i+1)); done\n"
                +"app_process /system/bin net.elfradio.elfremote.WifiRollbackMain "+old+" "+enabled+" > "+shellPath(dir+"/restored")+"\n";
    }
    private static String shellPath(String path) {
        if(path==null || path.isEmpty() || path.indexOf('\0')>=0 || path.indexOf('\n')>=0 || path.indexOf('\r')>=0)
            throw new IllegalArgumentException("wifi-guard-invalid-path");
        return "'"+path.replace("'","'\"'\"'")+"'";
    }
    private void poll() {
        if(done==null) return;
        try {
            WifiInfo info=wifi.getConnectionInfo();
            if(info!=null && info.getNetworkId()==state.getInt("target",-2) && info.getIpAddress()!=0 && reachesServer()) {
                restoreEnabled(); complete(true,"wifi-connected");return;
            }
        }catch(Exception ignored){}
        if(android.os.SystemClock.elapsedRealtime()>=deadline) rollback("wifi-timeout-rolled-back");
        else worker.postDelayed(poll,2000L);
    }
    private boolean reachesServer() {
        for(Network n:cm.getAllNetworks()) {
            NetworkCapabilities caps=cm.getNetworkCapabilities(n);
            if(caps==null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
            java.net.HttpURLConnection connection=null;
            try {
                connection=(java.net.HttpURLConnection)n.openConnection(new java.net.URL(BuildConfig.CONTROL_URL+"/"));
                connection.setConnectTimeout(3000);connection.setReadTimeout(3000);connection.setInstanceFollowRedirects(false);
                connection.setRequestMethod("HEAD");int status=connection.getResponseCode();return status>=200 && status<400;
            }catch(Exception ignored){}finally{if(connection!=null) connection.disconnect();}
        }
        return false;
    }
    private void restoreEnabled() {
        for(String id:state.getString("enabled","").trim().split(" +")) if(!id.isEmpty()) wifi.enableNetwork(Integer.parseInt(id),false);
    }
    private void rollback(String reason) {
        worker.removeCallbacks(poll);
        try {
            if(wifi==null) throw new IOException("wifi-unavailable");
            if(state.getBoolean("created",false)) {
                int target=state.getInt("target",-1);
                List<WifiConfiguration> configs=wifi.getConfiguredNetworks();
                if(configs==null) throw new IOException("wifi-config-unavailable");
                for(WifiConfiguration c:configs) if((target>=0&&c.networkId==target)||(target<0&&state.getString("ssid","").equals(c.SSID)))
                    if(!wifi.removeNetwork(c.networkId)) throw new IOException("wifi-remove-failed");
            }
            if(!wifi.enableNetwork(state.getInt("old",-1),true)) throw new IOException("wifi-restore-failed");
            restoreEnabled();wifi.reconnect();
            worker.postDelayed(()->verifyRollback(reason),2000L);
        }catch(Exception error) {RuntimeLog.event("wifi_rollback_pending");worker.postDelayed(()->rollback(reason),10000L);}
    }
    private void verifyRollback(String reason) {
        if(!state.getBoolean("active",false)) return;
        try {
            WifiInfo info=wifi.getConnectionInfo();
            if(info!=null && info.getNetworkId()==state.getInt("old",-1) && info.getIpAddress()!=0 && reachesServer()) {
                complete(false,reason);return;
            }
        }catch(Exception ignored){}
        worker.postDelayed(()->verifyRollback(reason),10000L);
    }
    private void complete(boolean ok,String result) throws Exception {
        if(!state.edit().putBoolean("active",false).putBoolean("ok",ok).putString("result",result).commit()) throw new IOException("wifi-state-unavailable");
        if(!guardDir.isDirectory()) guardDir.mkdirs();
        try(FileOutputStream out=new FileOutputStream(new File(guardDir,"cancel"))){out.write(1);out.getFD().sync();}
        RuntimeLog.event("wifi_connect_end result="+result);
        Done callback=done;done=null;if(callback!=null) callback.finish(ok,result);
    }
}
