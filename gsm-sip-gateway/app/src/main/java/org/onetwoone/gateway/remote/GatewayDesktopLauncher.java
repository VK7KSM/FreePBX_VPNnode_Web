package org.onetwoone.gateway.remote;

import android.system.Os;
import java.io.*;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * 核心（root）里的 scrcpy 服务端安装与拉起。
 * scrcpy 对系统服务自称 com.android.shell，剪贴板等服务会校验调用方 uid，必须以 uid 2000 运行，不能用 root。
 * Magisk 的 su 只改 uid、不改 SELinux 域，子进程仍在 u:r:magisk:s0，应用因此能连上它开的抽象套接字。
 * 视频与控制字节由应用进程直连 localabstract:scrcpy_&lt;scid&gt;，核心不转发任何一个字节。
 */
final class GatewayDesktopLauncher {
    private final File root,log;
    private Process current;
    private String currentScid="";

    GatewayDesktopLauncher(){this(new File(GatewayScrcpyAsset.ROOT));}
    GatewayDesktopLauncher(File root){this.root=root;log=new File(root,"desktop.log");}

    private static String quote(String value){return "'"+value.replace("'","'\\''")+"'";}

    /** 安装：校验应用暂存文件，复制到 uid 2000 可读的桌面目录。核心目录仍保持 0700。 */
    synchronized JSONObject prepare(JSONObject request)throws Exception {
        String source=request.optString("asset_path");
        if(!GatewayScrcpyAsset.safeSource(source)||request.optLong("size")!=GatewayScrcpyAsset.SIZE
                ||!GatewayScrcpyAsset.SHA256.equals(request.optString("sha256")))throw new SecurityException("scrcpy asset request invalid");
        File parent=new File(GatewayScrcpyAsset.PARENT);
        if(!parent.isDirectory()&&!parent.mkdirs())throw new IOException("gateway root unavailable");
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("desktop root unavailable");
        // 只放开「可穿越」不放开「可列目录」；核心目录另有 0700，认证口令不受影响。
        Os.chmod(parent.getPath(),0711);Os.chmod(root.getPath(),0711);
        if(!GatewayScrcpyAsset.verifyInstalled()){
            File input=new File(source).getCanonicalFile();
            if(!GatewayProxyAssets.valid(input,GatewayScrcpyAsset.SIZE,GatewayScrcpyAsset.SHA256))throw new SecurityException("scrcpy staged asset invalid");
            File next=new File(root,"scrcpy-server.new");
            if(next.exists()&&!next.delete())throw new IOException("scrcpy temporary cleanup failed");
            GatewayProxyAssets.copyVerified(new BufferedInputStream(new FileInputStream(input)),next,GatewayScrcpyAsset.SIZE,GatewayScrcpyAsset.SHA256,GatewayScrcpyAsset.SIZE);
            Os.chmod(next.getPath(),0644);
            File target=new File(GatewayScrcpyAsset.TARGET);
            if(target.exists()&&!target.delete())throw new IOException("scrcpy replacement unavailable");
            if(!next.renameTo(target))throw new IOException("scrcpy commit failed");
        }
        Os.chmod(GatewayScrcpyAsset.TARGET,0644);
        return status();
    }

    synchronized JSONObject start(JSONObject request)throws Exception {
        String scid=request.optString("scid");
        if(!GatewayDesktopPolicy.validScid(scid))throw new IllegalArgumentException("scid invalid");
        if(!GatewayScrcpyAsset.verifyInstalled())throw new IllegalStateException("scrcpy server not installed");
        JSONObject bounded=GatewayDesktopPolicy.bound(request);
        stopLocked();
        if(log.length()>262144&&!log.delete())throw new IOException("desktop log rotate failed");
        String server="CLASSPATH="+GatewayScrcpyAsset.TARGET+" app_process / com.genymobile.scrcpy.Server "+GatewayScrcpyAsset.VERSION
                +" scid="+scid+" tunnel_forward=true audio=false control=true cleanup=true power_on=true"
                +" send_dummy_byte=false log_level=info max_fps="+bounded.getInt("max_fps")
                +" video_bit_rate="+bounded.getInt("bit_rate")
                +(bounded.getInt("max_size")>0?" max_size="+bounded.getInt("max_size"):"");
        // setsid 让它自成进程组，核心重启不牵连；su 2000 只降 uid，SELinux 域不变。
        current=new ProcessBuilder("/system/bin/setsid","/system/bin/sh","-c",
                "PATH=/sbin:/system/xbin:/system/bin:$PATH; exec su 2000 -c "+quote(server)
                        +" </dev/null >>"+quote(log.getPath())+" 2>&1").start();
        currentScid=scid;
        return new JSONObject().put("scid",scid).put("socket","scrcpy_"+scid).put("version",GatewayScrcpyAsset.VERSION)
                .put("max_fps",bounded.getInt("max_fps")).put("bit_rate",bounded.getInt("bit_rate")).put("max_size",bounded.getInt("max_size"));
    }

    synchronized JSONObject stop()throws Exception {stopLocked();return status();}

    synchronized JSONObject status()throws Exception {
        boolean alive=current!=null&&current.isAlive();
        return new JSONObject().put("installed",GatewayScrcpyAsset.verifyInstalled()).put("version",GatewayScrcpyAsset.VERSION)
                .put("running",alive).put("scid",alive?currentScid:"").put("checked_at_ms",System.currentTimeMillis());
    }

    /** 按 scid 精确结束：ps 看不到完整参数，所以直接读 /proc 的 cmdline 匹配，连 su 与 app_process 两层一起收掉。 */
    private void stopLocked(){
        if(!currentScid.isEmpty())killByScid(currentScid);
        if(current!=null){try{current.destroy();}catch(Exception ignored){}current=null;}
        currentScid="";
    }

    static void killByScid(String scid){
        if(!GatewayDesktopPolicy.validScid(scid))return;
        String marker="scid="+scid;
        File[] entries=new File("/proc").listFiles();
        if(entries==null)return;
        for(File entry:entries){
            if(!entry.getName().matches("[0-9]+"))continue;
            int pid;
            try{pid=Integer.parseInt(entry.getName());}catch(NumberFormatException skip){continue;}
            if(pid<2||pid==android.os.Process.myPid())continue;
            String command=readCmdline(new File(entry,"cmdline"));
            if(command==null||!command.contains(marker))continue;
            try{android.os.Process.killProcess(pid);}catch(Exception ignored){}
        }
        waitGone(marker);
    }

    private static void waitGone(String marker){
        for(int attempt=0;attempt<25;attempt++){
            boolean present=false;
            File[] entries=new File("/proc").listFiles();
            if(entries!=null)for(File entry:entries){
                if(!entry.getName().matches("[0-9]+"))continue;
                String command=readCmdline(new File(entry,"cmdline"));
                if(command!=null&&command.contains(marker)){present=true;break;}
            }
            if(!present)return;
            try{TimeUnit.MILLISECONDS.sleep(200);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return;}
        }
    }

    /** cmdline 以 NUL 分隔，读成以空格分隔的一行供匹配；进程随时可能消失，读失败即当作不匹配。 */
    private static String readCmdline(File file){
        try(InputStream input=new FileInputStream(file)){
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            byte[] buffer=new byte[4096];
            for(int count;(count=input.read(buffer))!=-1;){bytes.write(buffer,0,count);if(bytes.size()>65536)break;}
            return new String(bytes.toByteArray(),java.nio.charset.StandardCharsets.UTF_8).replace('\0',' ');
        }catch(IOException unavailable){return null;}
    }
}
