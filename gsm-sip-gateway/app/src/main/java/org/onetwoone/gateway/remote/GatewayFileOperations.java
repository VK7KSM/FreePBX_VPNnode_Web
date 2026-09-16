package org.onetwoone.gateway.remote;

import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fixed, structured filesystem operations used by the Pixel root helper. */
final class GatewayFileOperations {
    static JSONObject normalize(JSONObject input) throws Exception {
        if(input==null)throw new IOException("missing params");
        Set<String> allowed=new HashSet<>(Arrays.asList("action","path","target","overwrite","offset"));
        for(Iterator<String> keys=input.keys();keys.hasNext();)if(!allowed.contains(keys.next()))throw new IOException("unexpected field");
        String action=input.getString("action"),path=input.getString("path");
        if(!Arrays.asList("list","mkdir","copy","move","trash","delete").contains(action))throw new IOException("unsupported action");
        validatePath(path);JSONObject result=new JSONObject().put("action",action).put("path",path);
        if("copy".equals(action)||"move".equals(action)){
            String target=input.getString("target");validatePath(target);result.put("target",target).put("overwrite",input.optBoolean("overwrite",false));
        }
        int offset=input.optInt("offset",0);if(offset<0)throw new IOException("invalid offset");return result.put("offset",offset);
    }
    static JSONObject run(JSONObject input)throws Exception {return run(input,null);}
    static JSONObject run(JSONObject input,File cancel)throws Exception {
        long started=System.nanoTime();JSONObject params=normalize(input);String action=params.getString("action");File source=new File(params.getString("path"));JSONObject output;
        if("list".equals(action))output=list(source,params.getInt("offset"));
        else {
            if(source.getParentFile()==null)throw new IOException("root path cannot be modified");
            File parent=source.getParentFile().getCanonicalFile();if(!parent.isDirectory())throw new IOException("parent directory missing");
            output=new JSONObject();
            if("mkdir".equals(action)){
                if(source.exists()||isLink(source)||!source.mkdir())throw new IOException("directory creation failed");output.put("path",source.getPath());
            }else if("delete".equals(action)){
                if(!source.exists()&&!isLink(source))throw new IOException("source missing");delete(source,cancel,started,0);output.put("path",source.getPath());
            }else {
                if(!source.exists()&&!isLink(source))throw new IOException("source missing");
                File target="trash".equals(action)?new File(parent,".elfremote-trash-"+System.currentTimeMillis()+"-"+source.getName()):new File(params.getString("target"));
                boolean occupied=target.exists()||isLink(target);if(occupied&&!params.optBoolean("overwrite"))throw new IOException("target exists");
                if(target.getParentFile()==null||!target.getParentFile().isDirectory())throw new IOException("target parent missing");
                String src=source.getCanonicalPath(),dst=target.getCanonicalPath();
                if(src.equals(dst)||dst.startsWith(src+File.separator)||src.startsWith(dst+File.separator))throw new IOException("source and target overlap");
                File backup=new File(target.getParentFile(),".elfremote-replaced-"+System.currentTimeMillis()+"-"+target.getName());
                if(occupied&&(backup.exists()||isLink(backup)||!target.renameTo(backup)))throw new IOException("target backup failed");
                try {
                    if("copy".equals(action)){
                        File stage=new File(target.getParentFile(),".elfremote-copy-"+System.currentTimeMillis());
                        try{copy(source,stage,cancel,started,0);if(target.exists()||isLink(target)||!stage.renameTo(target))throw new IOException("copy commit failed");}
                        catch(Exception failure){removeStage(stage);throw failure;}
                    }else if(!source.renameTo(target))throw new IOException("move failed");
                }catch(Exception failure){if(occupied&&!target.exists()&&!isLink(target)&&!backup.renameTo(target))throw new IOException("operation failed; backup retained",failure);throw failure;}
                if(occupied)try{removeStage(backup);}catch(IOException cleanup){output.put("backup_retained",backup.getPath());}
                output.put("path",target.getPath());if("trash".equals(action))output.put("restore_to",source.getPath());
            }
        }
        return new JSONObject().put("state","completed").put("exit_code",0).put("action",action)
                .put("elapsed_ms",(System.nanoTime()-started)/1_000_000L).put("output",output.toString()).put("truncated",false);
    }
    private static JSONObject list(File directory,int offset)throws Exception {
        File[] files=directory.listFiles();if(files==null)throw new IOException("directory unavailable");
        Arrays.sort(files,Comparator.comparing((File file)->!file.isDirectory()).thenComparing(File::getName));
        JSONArray entries=new JSONArray();int next=offset,bytes=0;
        for(;next<files.length&&entries.length()<12;next++){
            File file=files[next];boolean link=isLink(file);JSONObject item=new JSONObject().put("name",file.getName())
                    .put("directory",file.isDirectory()).put("link",link).put("bytes",file.isFile()?file.length():0).put("modified_ms",file.lastModified());
            try{android.system.StructStat stat=android.system.Os.lstat(file.getPath());item.put("mode",stat.st_mode&07777).put("uid",stat.st_uid).put("gid",stat.st_gid);}catch(Exception ignored){}
            int size=item.toString().getBytes("UTF-8").length;if(entries.length()>0&&bytes+size>11000)break;bytes+=size;entries.put(item);
        }
        return new JSONObject().put("path",directory.getCanonicalPath()).put("entries",entries).put("total",files.length).put("next",next<files.length?next:-1);
    }
    private static void validatePath(String path)throws IOException {
        if(path==null||!(path.startsWith("/")||(File.separatorChar=='\\'&&new File(path).isAbsolute()))||path.length()>1024||path.indexOf('\0')>=0)throw new IOException("absolute path required");
        for(String part:path.replace('\\','/').split("/"))if(".".equals(part)||"..".equals(part))throw new IOException("relative path rejected");
    }
    private static boolean isLink(File file)throws IOException {File parent=file.getParentFile();return parent!=null&&!new File(parent.getCanonicalFile(),file.getName()).getAbsoluteFile().equals(file.getCanonicalFile());}
    private static void check(File cancel,long started)throws IOException {if(cancel!=null&&cancel.exists())throw new IOException("operation cancelled");if(System.nanoTime()-started>120_000_000_000L)throw new IOException("operation timeout");}
    private static void copy(File from,File to,File cancel,long started,int depth)throws Exception {
        check(cancel,started);if(depth>64||isLink(from))throw new IOException("unsupported tree");
        if(from.isDirectory()){if(!to.mkdir())throw new IOException("copy directory failed");File[] children=from.listFiles();if(children==null)throw new IOException("source unreadable");for(File child:children)copy(child,new File(to,child.getName()),cancel,started,depth+1);}
        else if(from.isFile()){
            long size=from.length(),modified=from.lastModified();try(InputStream in=new FileInputStream(from);FileOutputStream out=new FileOutputStream(to)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1){check(cancel,started);out.write(buffer,0,n);}out.getFD().sync();}
            if(from.length()!=size||from.lastModified()!=modified||to.length()!=size||!sha256(from).equals(sha256(to)))throw new IOException("copy verification failed");to.setLastModified(modified);
        }else throw new IOException("unsupported source");
    }
    private static void delete(File file,File cancel,long started,int depth)throws IOException {check(cancel,started);if(depth>64)throw new IOException("tree too deep");if(!isLink(file)&&file.isDirectory()){File[] children=file.listFiles();if(children==null)throw new IOException("directory unreadable");for(File child:children)delete(child,cancel,started,depth+1);}if(!file.delete())throw new IOException("delete failed");}
    private static void removeStage(File file)throws IOException {if(!file.exists())return;if(file.isDirectory()&&!isLink(file)){File[] children=file.listFiles();if(children!=null)for(File child:children)removeStage(child);}if(!file.delete())throw new IOException("stage cleanup failed");}
    private static String sha256(File file)throws Exception {MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1)digest.update(buffer,0,n);}StringBuilder value=new StringBuilder();for(byte item:digest.digest())value.append(String.format(Locale.ROOT,"%02x",item&255));return value.toString();}
    private GatewayFileOperations(){}
}
