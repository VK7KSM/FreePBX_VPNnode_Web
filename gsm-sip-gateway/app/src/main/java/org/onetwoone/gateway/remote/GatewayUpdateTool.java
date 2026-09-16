package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.pm.PackageManager;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Standalone verification/staging only; install admission is not yet enabled. */
public final class GatewayUpdateTool {
    public static void main(String[] args) {
        try {
            if(android.os.Process.myUid()!=0)throw new SecurityException("root required");
            Context context=systemContext();
            if(args.length==2&&"managed".equals(args[0])) {
                GatewayManagedUpdate.run(context,new File(args[1]));return;
            }
            if(org.onetwoone.gateway.BuildConfig.DEBUG&&args.length==3
                    &&("lab-install".equals(args[0])||"lab-rollback".equals(args[0]))) {
                if(!args[2].matches("lab-[a-z0-9-]{1,60}"))throw new SecurityException("invalid lab transaction");
                File target=new File(args[1]).getCanonicalFile();
                if(!target.getPath().startsWith("/data/local/tmp/gateway-update-"))throw new SecurityException("invalid lab artifact path");
                JSONObject actual=GatewayApkVerifier.inspect(context.getPackageManager(),target);
                File directory=new File("/data/local/elfremote-gateway/updates/"+args[2]);
                if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("transaction directory unavailable");
                android.system.Os.chmod(directory.getPath(),0700);
                android.system.Os.chmod(directory.getParent(),0700);
                try(RandomAccessFile lockFile=new RandomAccessFile(new File(directory.getParentFile(),"transaction.lock"),"rw");
                    java.nio.channels.FileLock lock=lockFile.getChannel().tryLock()) {
                    if(lock==null)throw new IOException("another update is active");
                    File frozen=new File(directory,"target.apk");
                    try(InputStream source=new FileInputStream(target)) {
                        GatewayArtifactDownload.copyVerified(source,frozen,actual.getLong("size"),actual.getString("sha256"),System.nanoTime()+60_000_000_000L);
                    }
                    String identity=GatewayAppHealth.read(context).getString("identity_sha256");
                    GatewayAndroidUpdate platform=new GatewayAndroidUpdate(context,frozen,directory,identity,"lab-rollback".equals(args[0]));
                    if(platform.read()==null&&actual.getInt("versionCode")<=context.getPackageManager().getPackageInfo(GatewayRemotePolicy.PACKAGE,0).versionCode)
                        throw new SecurityException("lab target must be newer");
                    String result=GatewayUpdateTransaction.run(platform,args[2],actual.getString("sha256"));
                    System.out.println(new JSONObject().put("state",result).put("lab_only",true));return;
                }
            }
            if(args.length==1&&"health".equals(args[0])) {
                JSONObject health=GatewayAppHealth.read(context);health.remove("identity_sha256");
                System.out.println(health);return;
            }
            if(args.length!=2)throw new IllegalArgumentException("expected inspect or stage and path");
            if("inspect".equals(args[0])) {
                System.out.println(GatewayApkVerifier.inspect(context.getPackageManager(),new File(args[1])));
            } else if("stage".equals(args[0])) {
                File jobFile=new File(args[1]).getCanonicalFile();
                File root=new File("/data/local/elfremote-gateway/updates").getCanonicalFile();
                if(!root.equals(jobFile.getParentFile())||!jobFile.isFile()||jobFile.length()>131072)throw new SecurityException("invalid job path");
                JSONObject job=new JSONObject(new String(new AtomicFile(jobFile).readFully(),StandardCharsets.UTF_8));
                int installed=context.getPackageManager().getPackageInfo(GatewayRemotePolicy.PACKAGE,0).versionCode;
                JSONObject manifest=GatewayUpdatePolicy.validateOffer(job,job.getString("device_id"),installed,System.currentTimeMillis());
                File apk=new File(root,manifest.getString("sha256")+".apk");
                try(RandomAccessFile lockFile=new RandomAccessFile(new File(root,"stage.lock"),"rw");
                    java.nio.channels.FileLock lock=lockFile.getChannel().tryLock()) {
                    if(lock==null)throw new IOException("staging busy");
                    GatewayArtifactDownload.download(manifest,apk);
                    GatewayApkVerifier.matches(GatewayApkVerifier.inspect(context.getPackageManager(),apk),manifest);
                    JSONObject result=new JSONObject().put("state","verified").put("install_enabled",false)
                            .put("sha256",manifest.getString("sha256")).put("versionCode",manifest.getInt("versionCode"))
                            .put("task_id",job.getString("task_id")).put("expires_at",Math.min(manifest.getLong("expires_at"),job.getLong("task_expires_at")));
                    AtomicFile record=new AtomicFile(new File(root,"verified-"+job.getString("task_id")+".json"));FileOutputStream output=record.startWrite();
                    try{output.write(result.toString().getBytes(StandardCharsets.UTF_8));record.finishWrite(output);}
                    catch(Exception error){record.failWrite(output);throw error;}
                    System.out.println(result);
                }
            } else throw new IllegalArgumentException("unsupported operation");
        } catch(Exception error) {System.err.println("gateway-update-error="+error.getClass().getSimpleName());System.exit(2);}
    }
    private static Context systemContext() throws Exception {
        if(android.os.Looper.getMainLooper()==null)android.os.Looper.prepareMainLooper();
        Object thread=Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
        return (Context)thread.getClass().getMethod("getSystemContext").invoke(thread);
    }
}
