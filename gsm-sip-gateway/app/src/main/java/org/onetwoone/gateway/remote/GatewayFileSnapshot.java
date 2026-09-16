package org.onetwoone.gateway.remote;

import java.io.*;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Root-side immutable snapshot used before returning a file to the Web console. */
final class GatewayFileSnapshot {
    static JSONObject run(File task,JSONObject p)throws Exception {
        File requested=new File(p.getString("path")).getAbsoluteFile(),source=requested.getCanonicalFile();
        if(!requested.equals(source))throw new IOException("symbolic source rejected");
        File target=new File(p.getString("target")).getCanonicalFile();
        if(!source.isFile()||target.exists()||target.getParentFile()==null||!target.getParentFile().isDirectory())
            throw new IOException("snapshot path unavailable");
        long size=source.length(),modified=source.lastModified();
        if(size<0||size>GatewayFileCommit.MAX_BYTES)throw new IOException("source too large");
        if(target.getParentFile().getUsableSpace()<size+GatewayFileCommit.SPACE_RESERVE)throw new IOException("insufficient space");
        File stage=new File(target.getPath()+".tmp");if(stage.exists())throw new IOException("stale snapshot");
        try {
            MessageDigest digest=MessageDigest.getInstance("SHA-256");long copied=0;
            long deadline=System.nanoTime()+1800L*1_000_000_000L;
            try(InputStream in=new FileInputStream(source);FileOutputStream out=new FileOutputStream(stage)){
                byte[] buffer=new byte[65536];int count;
                while((count=in.read(buffer))!=-1){
                    if(new File(task,"cancel").exists())throw new IOException("cancelled");
                    if(System.nanoTime()>deadline)throw new IOException("snapshot timeout");
                    copied+=count;if(copied>size)throw new IOException("source changed");
                    out.write(buffer,0,count);digest.update(buffer,0,count);
                }
                out.getFD().sync();
            }
            if(copied!=size||source.length()!=size||source.lastModified()!=modified)throw new IOException("source changed");
            if("Dalvik".equals(System.getProperty("java.vm.name"))){android.system.Os.chown(stage.getPath(),p.getInt("uid"),p.getInt("uid"));android.system.Os.chmod(stage.getPath(),0600);}
            if(new File(task,"cancel").exists())throw new IOException("cancelled");
            if(!stage.renameTo(target))throw new IOException("snapshot commit failed");
            return new JSONObject().put("action","snapshot").put("bytes",size)
                    .put("sha256",GatewayFileCommit.hex(digest.digest()));
        }finally{if(stage.exists())stage.delete();}
    }
    private GatewayFileSnapshot(){}
}
