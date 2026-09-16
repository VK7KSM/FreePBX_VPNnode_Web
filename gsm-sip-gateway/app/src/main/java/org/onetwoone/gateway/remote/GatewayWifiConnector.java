package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.SystemClock;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Root-assisted Wi-Fi transaction with independent timeout rollback. */
final class GatewayWifiConnector {
    interface Done {void finish(boolean ok,String detail,JSONObject result);}
    private final Context context;private final Handler worker;private final WifiManager wifi;private final ConnectivityManager connectivity;
    private final SharedPreferences prefs;private final File base;private Done done;private File dir;private long deadline;private int target;
    private final Runnable poll=this::poll;
    GatewayWifiConnector(Context context,Handler worker){this.context=context.getApplicationContext();this.worker=worker;
        wifi=(WifiManager)this.context.getSystemService(Context.WIFI_SERVICE);connectivity=(ConnectivityManager)this.context.getSystemService(Context.CONNECTIVITY_SERVICE);
        prefs=this.context.getSharedPreferences("gateway-wifi",Context.MODE_PRIVATE);base=new File(this.context.getFilesDir(),"gateway-wifi");}
    boolean busy(){return done!=null||prefs.getBoolean("active",false);}
    String pendingTask(){return prefs.getBoolean("active",false)?prefs.getString("task",""):"";}
    void recover(Done callback){if(!prefs.getBoolean("active",false))return;done=callback;dir=new File(prefs.getString("dir",""));target=prefs.getInt("target",-1);rollback("wifi-interrupted-rolled-back");}
    void connect(String task,JSONObject params,Done callback)throws Exception {
        GatewayWifiPolicy.connectParams(params);if(busy())throw new IOException("wifi busy");
        if(wifi==null||!wifi.isWifiEnabled())throw new IOException("wifi disabled");
        dir=new File(base,GatewayRemoteStore.hash(task));if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("wifi transaction unavailable");
        write(new File(dir,"request.json"),params);runRoot("prepare",dir,15);JSONObject prepared=readResult(dir);
        JSONObject state=new JSONObject().put("task",task).put("old",prepared.getInt("old")).put("target",prepared.getInt("target"))
                .put("created",prepared.getBoolean("created")).put("ssid",prepared.getString("ssid")).put("enabled",prepared.getJSONArray("enabled"));
        write(new File(dir,"state.json"),state);
        if(!prefs.edit().clear().putBoolean("active",true).putString("task",task).putString("dir",dir.getCanonicalPath())
                .putInt("old",state.getInt("old")).putInt("target",state.getInt("target")).commit())throw new IOException("wifi state unavailable");
        done=callback;
        if(state.getInt("old")==state.getInt("target")){complete(true,"wifi-unchanged",new JSONObject().put("stage","wifi").put("action","unchanged").put("verified",true));return;}
        try {
            armGuard(dir);runRoot("apply",dir,15);target=readResult(dir).getInt("target");prefs.edit().putInt("target",target).apply();
            deadline=SystemClock.elapsedRealtime()+90_000L;worker.postDelayed(poll,2_000L);
        } catch(Exception failure) {rollback("wifi-connect-failed-rolled-back");}
    }
    private void armGuard(File dir)throws Exception {
        File ready=new File(dir,"guard.ready"),cancel=new File(dir,"guard.cancel");ready.delete();cancel.delete();
        String apk=context.getApplicationInfo().sourceDir,path=dir.getCanonicalPath();File script=new File(dir,"guard.sh");
        String shell="#!/system/bin/sh\nset -e\necho ready > "+quote(ready.getPath())+"\n"
                +"i=0\nwhile [ $i -lt 120 ]; do [ ! -f "+quote(cancel.getPath())+" ] || exit 0; sleep 1; i=$((i+1)); done\n"
                +"export CLASSPATH="+quote(apk)+"\n/system/bin/app_process /system/bin org.onetwoone.gateway.remote.GatewayWifiRootMain restore "+quote(path)+" >"+quote(new File(dir,"guard.log").getPath())+" 2>&1\n";
        try(FileOutputStream out=new FileOutputStream(script)){out.write(shell.getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Process process=new ProcessBuilder("su","-c","sh "+quote(script.getPath())+" </dev/null >/dev/null 2>&1 &").start();
        long until=SystemClock.elapsedRealtime()+5_000L;while(!ready.exists()&&SystemClock.elapsedRealtime()<until)Thread.sleep(50);
        if(!ready.exists())throw new IOException("wifi guard unavailable");
    }
    private void poll(){if(done==null)return;try{WifiInfo info=wifi.getConnectionInfo();if(info!=null&&info.getNetworkId()==target&&info.getIpAddress()!=0&&reachesServer()){
                runRoot("commit",dir,15);complete(true,"wifi-connected",new JSONObject().put("stage","wifi").put("action","connected").put("verified",true));return;}}
        catch(Exception ignored){}
        if(SystemClock.elapsedRealtime()>=deadline)rollback("wifi-timeout-rolled-back");else worker.postDelayed(poll,2_000L);
    }
    private boolean reachesServer(){
        if(connectivity==null)return false;for(Network network:connectivity.getAllNetworks()){
            NetworkCapabilities caps=connectivity.getNetworkCapabilities(network);if(caps==null||!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))continue;
            java.net.HttpURLConnection connection=null;try{connection=(java.net.HttpURLConnection)network.openConnection(new java.net.URL(GatewayRemotePolicy.BASE_URL+"/"));
                connection.setConnectTimeout(3_000);connection.setReadTimeout(3_000);connection.setInstanceFollowRedirects(false);connection.setRequestMethod("HEAD");
                int status=connection.getResponseCode();return status>=200&&status<400;}catch(Exception ignored){}finally{if(connection!=null)connection.disconnect();}
        }return false;
    }
    private void rollback(String reason){worker.removeCallbacks(poll);try{runRoot("restore",dir,15);worker.postDelayed(()->verifyRollback(reason),2_000L);}
        catch(Exception error){worker.postDelayed(()->rollback(reason),10_000L);}}
    private void verifyRollback(String reason){if(done==null)return;try{WifiInfo info=wifi.getConnectionInfo();if(info!=null&&info.getNetworkId()==prefs.getInt("old",-1)&&info.getIpAddress()!=0&&reachesServer()){
                complete(false,reason,new JSONObject().put("stage","wifi").put("action","rolled_back").put("verified",true));return;}}
        catch(Exception ignored){}worker.postDelayed(()->verifyRollback(reason),10_000L);}
    private void complete(boolean ok,String detail,JSONObject result)throws Exception {
        worker.removeCallbacks(poll);File cancel=new File(dir,"guard.cancel");try(FileOutputStream out=new FileOutputStream(cancel)){out.write(1);out.getFD().sync();}
        if(!prefs.edit().putBoolean("active",false).putBoolean("ok",ok).putString("result",detail).commit())throw new IOException("wifi state unavailable");
        new File(dir,"request.json").delete();Done callback=done;done=null;if(callback!=null)callback.finish(ok,detail,result);
    }
    private void runRoot(String operation,File dir,long timeout)throws Exception {
        String command="export CLASSPATH="+quote(context.getApplicationInfo().sourceDir)+"; exec /system/bin/app_process /system/bin org.onetwoone.gateway.remote.GatewayWifiRootMain "
                +operation+" "+quote(dir.getCanonicalPath());
        Process process=new ProcessBuilder("su","-c",command).redirectErrorStream(true).start();
        if(!process.waitFor(timeout,TimeUnit.SECONDS)){process.destroy();throw new IOException("wifi helper timeout");}
        if(process.exitValue()!=0)throw new IOException("wifi helper failed");
    }
    private static JSONObject readResult(File dir)throws Exception{return GatewayUpdateProgress.read(new File(dir,"result.json"));}
    private static void write(File file,JSONObject value)throws Exception{GatewayUpdateProgress.write(file,value);}
    static String quote(String value){if(value==null||value.indexOf('\0')>=0||value.indexOf('\n')>=0||value.indexOf('\r')>=0)throw new IllegalArgumentException("invalid path");return "'"+value.replace("'","'\"'\"'")+"'";}
}
