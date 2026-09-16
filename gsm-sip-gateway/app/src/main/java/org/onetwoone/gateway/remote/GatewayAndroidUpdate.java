package org.onetwoone.gateway.remote;

import android.content.Context;
import android.os.SystemClock;
import android.telecom.TelecomManager;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

final class GatewayAndroidUpdate implements GatewayUpdateTransaction.Platform {
    private final Context context;
    private final File target, directory, backup;
    private final String targetHash, identity;
    private final boolean simulateUnhealthy;
    GatewayUpdateProgress progress;
    GatewayAndroidUpdate(Context context,File target,File directory,String identity,boolean simulateUnhealthy) throws Exception {
        this.context=context;this.target=target.getCanonicalFile();this.directory=directory.getCanonicalFile();
        this.identity=identity;this.simulateUnhealthy=simulateUnhealthy;
        backup=new File(this.directory,"original.apk");
        JSONObject actual=GatewayApkVerifier.inspect(context.getPackageManager(),this.target);
        targetHash=actual.getString("sha256");
    }
    private File file(String name){return new File(directory,name);}
    @Override public JSONObject read() throws Exception {
        AtomicFile file=new AtomicFile(file("transaction.json"));
        return file.getBaseFile().exists()?new JSONObject(new String(file.readFully(),StandardCharsets.UTF_8)):null;
    }
    @Override public void write(JSONObject value) throws Exception {
        AtomicFile file=new AtomicFile(file("transaction.json"));FileOutputStream out=file.startWrite();
        try{out.write(value.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}
        catch(Exception failure){file.failWrite(out);throw failure;}
        String state=value.optString("state");
        if(progress!=null&&("installing".equals(state)||"wait_health".equals(state)||"rollback".equals(state)||"success".equals(state)||"recovered".equals(state)))progress.record(state);
    }
    private File installed() throws Exception {return new File(context.getPackageManager().getApplicationInfo(GatewayRemotePolicy.PACKAGE,0).sourceDir);}
    @Override public String installedHash() throws Exception {return GatewayApkVerifier.sha256(installed());}
    @Override public boolean idle() throws Exception {
        try {
            JSONObject health=GatewayAppHealth.read(context);
            int code=context.getPackageManager().getPackageInfo(GatewayRemotePolicy.PACKAGE,0).versionCode;
            TelecomManager telecom=context.getSystemService(TelecomManager.class);
            return telecom!=null&&!telecom.isInCall()&&GatewayInstallGate.liveIdle(health,identity,code,SystemClock.elapsedRealtime());
        } catch(IOException unavailable){return false;}
    }
    @Override public boolean recoveryIdle() {
        try {TelecomManager telecom=context.getSystemService(TelecomManager.class);return telecom!=null&&!telecom.isInCall();}
        catch(Exception unavailable){return false;}
    }
    @Override public void backup() throws Exception {
        File source=installed();String hash=GatewayApkVerifier.sha256(source);
        try(InputStream input=new FileInputStream(source)) {
            GatewayArtifactDownload.copyVerified(input,backup,source.length(),hash,System.nanoTime()+60_000_000_000L);
        }
        GatewayApkVerifier.inspect(context.getPackageManager(),backup);
    }
    @Override public void installTarget() throws Exception {
        if(!targetHash.equals(GatewayApkVerifier.sha256(target)))throw new SecurityException("target changed");
        install(target,false,false);
    }
    @Override public void installBackup() throws Exception {
        JSONObject journal=read();
        if(journal==null||!journal.getString("original").equals(GatewayApkVerifier.sha256(backup)))throw new SecurityException("backup changed");
        GatewayApkVerifier.inspect(context.getPackageManager(),backup);install(backup,true,true);
    }
    private void install(File apk,boolean downgrade,boolean recovery) throws Exception {
        if(!(recovery?recoveryIdle():idle()))throw new IOException("call state no longer idle");
        AtomicFile start=new AtomicFile(file("operation-start.txt"));FileOutputStream startOut=start.startWrite();
        try{startOut.write(Long.toString(System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8));start.finishWrite(startOut);}
        catch(Exception error){start.failWrite(startOut);throw error;}
        String script="echo $$ > "+quote(file("package.pid"))+"; exec /system/bin/cmd package install -r "+(downgrade?"-d ":"")+quote(apk);
        Process process=new ProcessBuilder("sh","-c",script).redirectErrorStream(true).redirectOutput(file("package-result-"+System.currentTimeMillis()+".txt")).start();
        if(!process.waitFor(90,TimeUnit.SECONDS))throw new IOException("package operation pending");
        if(process.exitValue()!=0)throw new IOException("package operation failed");
    }
    @Override public void startInstalled() throws Exception {
        startService(".PjsipSipService","sip");
        startService(".remote.GatewayRemoteService","management");
    }
    private void startService(String component,String label) throws Exception {
        Process process=new ProcessBuilder("/system/bin/am","start-foreground-service","--user","0","-n",GatewayRemotePolicy.PACKAGE+"/"+component)
                .redirectErrorStream(true).redirectOutput(file("service-start-"+label+".txt")).start();
        if(!process.waitFor(15,TimeUnit.SECONDS)){process.destroyForcibly();throw new IOException("service start timeout");}
        if(process.exitValue()!=0)throw new IOException("service start failed");
    }
    @Override public boolean operationSettled() throws Exception {
        if(!file("package.pid").isFile())return true;
        String pid=new String(new AtomicFile(file("package.pid")).readFully(),StandardCharsets.UTF_8).trim();
        if(!pid.matches("[0-9]{1,10}"))throw new SecurityException("invalid operation identity");
        File cmdline=new File("/proc/"+pid+"/cmdline");
        if(!cmdline.exists())return true;
        byte[] data=new byte[4096];int count;
        try(InputStream input=new FileInputStream(cmdline)){count=input.read(data);}
        String command=count<=0?"":new String(data,0,count,StandardCharsets.UTF_8);
        if(command.contains(target.getPath())||command.contains(backup.getPath()))return false;
        // A reused PID is not the package operation recorded by this transaction.
        return true;
    }
    @Override public boolean healthy(String hash) throws Exception {
        long deadline=SystemClock.elapsedRealtime()+90_000L;
        long started=file("operation-start.txt").exists()
                ?Long.parseLong(new String(new AtomicFile(file("operation-start.txt")).readFully(),StandardCharsets.UTF_8)):0;
        while(SystemClock.elapsedRealtime()<deadline) {
            try {
                JSONObject health=GatewayAppHealth.read(context);
                if(hash.equals(installedHash())&&identity.equals(health.optString("identity_sha256"))
                        &&health.optBoolean("running")&&health.optBoolean("sip_registered")&&health.optBoolean("paired")
                        &&health.optLong("last_report")>started) return !(simulateUnhealthy&&hash.equals(targetHash));
            } catch(IOException unavailable) { }
            Thread.sleep(1000);
        }
        return false;
    }
    private static String quote(File file){return "'"+file.getPath().replace("'","'\\''")+"'";}
}
