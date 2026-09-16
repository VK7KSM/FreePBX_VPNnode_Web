package org.onetwoone.gateway.remote;

import java.io.*;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Root-side atomic commit for a verified file downloaded by the app UID. */
final class GatewayFileCommit {
    static final long MAX_BYTES=4L*1024*1024*1024;
    static final long SPACE_RESERVE=32L*1024*1024;

    static JSONObject run(File task,JSONObject p)throws Exception {
        JSONObject recovered=recover(task);if(recovered!=null)return recovered;
        File source=new File(p.getString("source")).getCanonicalFile();
        File requested=new File(p.getString("path")).getAbsoluteFile(),target=requested.getCanonicalFile();
        if(!requested.equals(target))throw new IOException("symbolic target rejected");
        long size=p.getLong("size");String expected=p.getString("sha256");
        if(size<0||size>MAX_BYTES||!expected.matches("[a-f0-9]{64}")||!source.isFile()||source.length()!=size)
            throw new IOException("invalid source file");
        File parent=target.getParentFile();
        if(parent==null||!parent.isDirectory()||target.isDirectory())throw new IOException("target directory unavailable");
        File stage=new File(parent,".elfremote-"+task.getName()+".part");
        File backup=new File(parent,".elfremote-"+task.getName()+".bak");
        if(stage.exists()||backup.exists())throw new IOException("stale commit files");
        if(target.exists()&&!p.optBoolean("overwrite"))throw new IOException("target exists");
        if(parent.getUsableSpace()<size+SPACE_RESERVE)throw new IOException("insufficient space");
        JSONObject journal=new JSONObject().put("target",target.getPath()).put("stage",stage.getPath())
                .put("backup",backup.getPath()).put("size",size).put("sha256",expected)
                .put("original",target.exists()).put("phase","copying");
        GatewayUpdateProgress.write(new File(task,"commit.json"),journal);
        boolean moved=false;
        try {
            MessageDigest digest=MessageDigest.getInstance("SHA-256");long copied=0;
            long deadline=System.nanoTime()+1800L*1_000_000_000L;
            try(InputStream in=new FileInputStream(source);FileOutputStream out=new FileOutputStream(stage)){
                byte[] buffer=new byte[65536];int count;
                while((count=in.read(buffer))!=-1){
                    check(task,deadline);copied+=count;if(copied>size)throw new IOException("source changed");
                    out.write(buffer,0,count);digest.update(buffer,0,count);
                }
                out.getFD().sync();
            }
            if(copied!=size||!hex(digest.digest()).equals(expected))throw new IOException("commit verification failed");
            if("Dalvik".equals(System.getProperty("java.vm.name"))&&target.isFile()){
                android.system.StructStat stat=android.system.Os.stat(target.getPath());
                android.system.Os.chown(stage.getPath(),stat.st_uid,stat.st_gid);
                android.system.Os.chmod(stage.getPath(),stat.st_mode&0777);
            }else if("Dalvik".equals(System.getProperty("java.vm.name")))android.system.Os.chmod(stage.getPath(),0644);
            check(task,deadline);
            if(target.exists()&&!p.optBoolean("overwrite"))throw new IOException("target exists");
            journal.put("phase","prepared");GatewayUpdateProgress.write(new File(task,"commit.json"),journal);
            if(target.exists()){if(!target.isFile()||!target.renameTo(backup))throw new IOException("target backup failed");moved=true;}
            if(!stage.renameTo(target))throw new IOException("commit failed");
            journal.put("phase","committed");GatewayUpdateProgress.write(new File(task,"commit.json"),journal);
            if(backup.isFile()&&!backup.delete())journal.put("backup_retained",true);
            return new JSONObject().put("action","committed").put("bytes",size).put("sha256",expected)
                    .put("backup_retained",journal.optBoolean("backup_retained"));
        }catch(Exception failure){
            if(!target.exists()&&moved&&!backup.renameTo(target))throw new IOException("original recovery failed",failure);
            if(stage.exists())stage.delete();throw failure;
        }
    }

    static JSONObject recover(File task)throws Exception {
        File file=new File(task,"commit.json");if(!file.isFile())return null;
        JSONObject j=GatewayUpdateProgress.read(file);File target=new File(j.getString("target"));
        File stage=new File(j.getString("stage")),backup=new File(j.getString("backup"));
        if(!"copying".equals(j.optString("phase"))&&target.isFile()&&target.length()==j.getLong("size")
                &&sha256(target).equals(j.getString("sha256"))){
            if(backup.isFile()&&!backup.delete())j.put("backup_retained",true);
            return new JSONObject().put("action","committed").put("bytes",j.getLong("size"))
                    .put("sha256",j.getString("sha256")).put("backup_retained",j.optBoolean("backup_retained"));
        }
        if(!target.exists()&&backup.isFile()&&!backup.renameTo(target))throw new IOException("original recovery failed");
        if(stage.exists()&&!stage.delete())throw new IOException("stage cleanup failed");
        if(file.exists()&&!file.delete())throw new IOException("journal cleanup failed");
        return null;
    }

    private static void check(File task,long deadline)throws IOException {
        if(new File(task,"cancel").exists())throw new IOException("cancelled");
        if(System.nanoTime()>deadline)throw new IOException("commit timeout");
    }
    static String hex(byte[] bytes){StringBuilder value=new StringBuilder();for(byte b:bytes)value.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return value.toString();}
    private static String sha256(File file)throws Exception {MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int count;while((count=in.read(buffer))!=-1)digest.update(buffer,0,count);}return hex(digest.digest());}
    private GatewayFileCommit(){}
}
