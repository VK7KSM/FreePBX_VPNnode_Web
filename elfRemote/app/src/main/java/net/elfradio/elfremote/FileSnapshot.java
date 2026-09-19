package net.elfradio.elfremote;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;

/** root只生成只读快照，公网上传由应用UID完成。 */
final class FileSnapshot {
    static JSONObject run(File folder,JSONObject p)throws Exception{
        File source=new File(p.getString("source")).getCanonicalFile(),target=new File(p.getString("target"));
        if(!source.isFile()||!target.getParentFile().isDirectory()||target.exists())throw new IOException("源文件不存在或快照路径不可用");
        long size=source.length(),modified=source.lastModified();if(size<0||size>FileCommit.MAX_BYTES)throw new IOException("文件最大支持4 GB");
        if(target.getParentFile().getUsableSpace()<size+32L*1024*1024)throw new IOException("快照空间不足");
        File temp=new File(target.getPath()+".tmp");if(temp.exists())throw new IOException("已有未完成快照，请检查");
        try{
            MessageDigest hash=MessageDigest.getInstance("SHA-256");long copied=0,end=System.nanoTime()+1800L*1000000000;
            try(InputStream in=new FileInputStream(source);FileOutputStream out=new FileOutputStream(temp)){
                byte[] buf=new byte[65536];int n;while((n=in.read(buf))!=-1){
                    if(new File(folder,"cancel").exists())throw new IOException("文件取回已停止");
                    if(System.nanoTime()>end)throw new IOException("文件快照超时");copied+=n;if(copied>size)throw new IOException("源文件正在变化");out.write(buf,0,n);hash.update(buf,0,n);
                }out.getFD().sync();
            }
            if(copied!=size||source.length()!=size||source.lastModified()!=modified)throw new IOException("源文件正在变化，请稍后取回");
            if("Dalvik".equals(System.getProperty("java.vm.name"))){android.system.Os.chown(temp.getPath(),p.getInt("uid"),p.getInt("uid"));android.system.Os.chmod(temp.getPath(),0600);}
            JSONObject result=new JSONObject().put("state","completed").put("action","snapshot").put("bytes",size).put("sha256",FileCommit.hex(hash.digest())).put("path",target.getPath());
            RescueFiles.write(new File(folder,"snapshot.json"),result.toString());
            if(new File(folder,"cancel").exists())throw new IOException("文件取回已停止");
            if(!temp.renameTo(target))throw new IOException("提交文件快照失败");return result;
        }finally{temp.delete();}
    }
    static JSONObject recover(File folder)throws Exception{
        File meta=new File(folder,"snapshot.json");if(!meta.isFile())return null;JSONObject p=new JSONObject(RescueFiles.read(meta,4096));File snapshot=new File(p.getString("path"));
        return snapshot.isFile()&&snapshot.length()==p.getLong("bytes")&&RescueFiles.sha256(snapshot).equals(p.getString("sha256"))?p:null;
    }
}
