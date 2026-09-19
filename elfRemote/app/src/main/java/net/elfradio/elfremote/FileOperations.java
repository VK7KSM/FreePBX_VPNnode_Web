package net.elfradio.elfremote;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.util.Arrays;
import java.util.Comparator;

/** 独立核心的文件操作；路径作为数据处理，不拼接shell命令。 */
final class FileOperations {
    static JSONObject normalize(JSONObject value) throws Exception {
        String action=value.getString("action"), path=value.getString("path");
        if(!Arrays.asList("list","mkdir","copy","move","trash","delete").contains(action))throw new IOException("不支持的文件操作");
        validatePath(path);
        JSONObject result=new JSONObject().put("action",action).put("path",path);
        if("copy".equals(action)||"move".equals(action)) {
            String target=value.getString("target"); validatePath(target); result.put("target",target);
            result.put("overwrite",value.optBoolean("overwrite",false));
        }
        int offset=value.optInt("offset",0);
        if(offset<0)throw new IOException("列表页码无效");
        return result.put("offset",offset);
    }
    private static void validatePath(String path)throws IOException {
        if(!(path.startsWith("/")||(File.separatorChar=='\\'&&new File(path).isAbsolute()))||path.length()>1024||path.indexOf('\0')>=0)throw new IOException("需要完整绝对路径");
        for(String part:path.replace('\\','/').split("/"))if("..".equals(part)||".".equals(part))throw new IOException("路径不能包含相对目录");
    }
    static JSONObject run(File job,JSONObject value)throws Exception {
        long started=System.nanoTime();
        JSONObject p=normalize(value), out=new JSONObject();
        String action=p.getString("action"); File source=new File(p.getString("path"));
        if("list".equals(action)) out=list(source,p.getInt("offset"));
        else {
            if(source.getParentFile()==null)throw new IOException("不能操作根目录本身");
            File parent=source.getParentFile().getCanonicalFile();
            if(!parent.isDirectory())throw new IOException("父目录不存在");
            if("mkdir".equals(action)) {
                if(source.exists()||isLink(source)||!source.mkdir())throw new IOException("新建目录失败或同名路径已存在");
                out.put("path",source.getPath());
            }else if("delete".equals(action)) {
                if(!source.exists()&&!isLink(source))throw new IOException("源路径不存在");
                delete(source,new File(job,"cancel"),started,0);
                out.put("path",source.getPath());
            }else {
                if(!source.exists()&&!isLink(source))throw new IOException("源路径不存在");
                File target="trash".equals(action)?new File(parent,".elfremote-trash-"+job.getName()+"-"+source.getName()):new File(p.getString("target"));
                boolean occupied=target.exists()||isLink(target);
                if(occupied&&!p.optBoolean("overwrite"))throw new IOException("目标已存在，请使用其他名称");
                if(target.getParentFile()==null||!target.getParentFile().isDirectory())throw new IOException("目标父目录不存在");
                String src=source.getCanonicalPath(), dst=target.getCanonicalPath();
                if(src.equals(dst)||dst.startsWith(src+File.separator)||src.startsWith(dst+File.separator))throw new IOException("源与目标不能相同或互相包含");
                File backup=new File(target.getParentFile(),".elfremote-replaced-"+job.getName()+"-"+target.getName());
                if(occupied&&(backup.exists()||isLink(backup)||!target.renameTo(backup)))throw new IOException("同名目标备份失败，未覆盖");
                try {
                if("copy".equals(action)) {
                    File stage=new File(target.getParentFile(),".elfremote-copy-"+job.getName());
                    if(stage.exists()||isLink(stage))throw new IOException("发现此前复制现场，未覆盖");
                    try {
                        copy(source,stage,new File(job,"cancel"),started,0);
                        if(target.exists()||isLink(target)||!stage.renameTo(target))throw new IOException("复制完成后提交目标失败");
                    } catch(Exception error) { removeStage(stage);throw error; }
                } else if(!source.renameTo(target))throw new IOException("移动失败；跨存储请先复制，核对后再移除原件");
                } catch(Exception error) {
                    if(occupied&&!target.exists()&&!isLink(target)&&!backup.renameTo(target))throw new IOException("操作失败，原目标保留于："+backup.getPath(),error);
                    throw error;
                }
                out.put("path",target.getPath());
                if("trash".equals(action))out.put("restore_to",source.getPath());
            }
        }
        return new JSONObject().put("state","completed").put("exit_code",0).put("action",action)
                .put("elapsed_ms",(System.nanoTime()-started)/1000000).put("output",out.toString()).put("truncated",false);
    }
    private static JSONObject list(File dir,int offset)throws Exception {
        File[] files=dir.listFiles();if(files==null)throw new IOException("目录不存在或不可读取");
        Arrays.sort(files,Comparator.comparing((File f)->!f.isDirectory()).thenComparing(File::getName));
        JSONArray entries=new JSONArray();int next=offset;int bytes=0;
        for(;next<files.length&&entries.length()<12;next++) {
            File f=files[next];boolean link=isLink(f);
            JSONObject item=new JSONObject().put("name",f.getName()).put("directory",f.isDirectory()).put("link",link)
                    .put("bytes",f.isFile()?f.length():0).put("modified_ms",f.lastModified());
            // Android的实际权限；桌面测试或特殊文件不可读取时不伪造权限。
            try {
                android.system.StructStat stat=android.system.Os.lstat(f.getPath());
                item.put("mode",stat.st_mode & 07777).put("uid",stat.st_uid).put("gid",stat.st_gid);
            } catch(Exception unavailable) { }
            int size=item.toString().getBytes("UTF-8").length;
            if(entries.length()>0&&bytes+size>11000)break;
            bytes+=size;entries.put(item);
        }
        return new JSONObject().put("path",dir.getCanonicalPath()).put("entries",entries).put("total",files.length)
                .put("next",next<files.length?next:-1);
    }
    private static boolean isLink(File file)throws IOException {
        File parent=file.getParentFile();
        return parent!=null&&!new File(parent.getCanonicalFile(),file.getName()).getAbsoluteFile().equals(file.getCanonicalFile());
    }
    private static void copy(File from,File to,File cancel,long start,int depth)throws Exception {
        check(cancel,start);if(depth>64)throw new IOException("目录层级过深");
        if(isLink(from))throw new IOException("复制遇到符号链接，请单独处理该链接");
        if(from.isDirectory()) {
            if(!to.mkdir())throw new IOException("创建复制目录失败");
            File[] children=from.listFiles();if(children==null)throw new IOException("源目录不可读取");
            for(File child:children)copy(child,new File(to,child.getName()),cancel,start,depth+1);
        }else if(from.isFile()) {
            long size=from.length(),modified=from.lastModified();
            try(InputStream input=new FileInputStream(from);FileOutputStream output=new FileOutputStream(to)) {
                byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){check(cancel,start);output.write(buffer,0,n);}output.getFD().sync();
            }
            if(from.length()!=size||from.lastModified()!=modified||to.length()!=size||!RescueFiles.sha256(from).equals(RescueFiles.sha256(to)))throw new IOException("复制期间源文件变化或完整校验失败");
            to.setLastModified(modified);
        }else throw new IOException("仅复制普通文件或目录");
    }
    private static void check(File cancel,long start)throws IOException {
        if(cancel.exists())throw new IOException("文件操作已停止");
        if(System.nanoTime()-start>120000000000L)throw new IOException("复制超时，保留原文件");
    }
    private static void delete(File file,File cancel,long start,int depth)throws IOException {
        check(cancel,start);
        if(depth>64)throw new IOException("目录层级过深，删除未全部完成");
        // 符号链接只删除链接本身，绝不递归到链接指向的目录。
        if(!isLink(file)&&file.isDirectory()) {
            File[] children=file.listFiles();
            if(children==null)throw new IOException("目录不可读取，删除未全部完成");
            for(File child:children)delete(child,cancel,start,depth+1);
        }
        if(!file.delete())throw new IOException("无法删除："+file.getName());
    }
    private static void removeStage(File file)throws IOException {
        if(!file.exists())return;
        if(file.isDirectory()&&!isLink(file)){File[] children=file.listFiles();if(children!=null)for(File c:children)removeStage(c);}
        if(!file.delete())throw new IOException("临时复制文件待清理："+file.getPath());
    }
    private FileOperations(){}
}
