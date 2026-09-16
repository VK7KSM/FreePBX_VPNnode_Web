package org.onetwoone.gateway.remote;

import android.system.Os;
import android.system.OsConstants;
import java.io.*;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Root-owned proxy core, transactional configuration and single-process lifecycle. */
final class GatewayProxyRuntime {
    static final String ROOT=GatewayCoreClient.DIR+"/proxy";
    private final File root,binary,state,config,pidFile,log;
    private boolean verified;private Process child;
    GatewayProxyRuntime(){this(new File(ROOT));}
    GatewayProxyRuntime(File root){this.root=root;binary=new File(root,"mihomo");state=new File(root,"state.json");config=new File(root,"config.yaml");pidFile=new File(root,"mihomo.pid");log=new File(root,"mihomo.log");try{verified=verifyInstalled();}catch(Exception ignored){verified=false;}refreshRoute();}
    synchronized JSONObject prepare(JSONObject request)throws Exception {
        String source=request.optString("asset_path");
        if(!safeSource(source)||request.optLong("size")!=GatewayProxyAssets.EXECUTABLE_SIZE
                ||!GatewayProxyAssets.EXECUTABLE_SHA256.equals(request.optString("sha256")))throw new SecurityException("proxy asset request invalid");
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("proxy root unavailable");Os.chmod(root.getPath(),0700);
        if(!verified){File input=new File(source).getCanonicalFile();
            if(!GatewayProxyAssets.valid(input,GatewayProxyAssets.EXECUTABLE_SIZE,GatewayProxyAssets.EXECUTABLE_SHA256))throw new SecurityException("proxy staged asset invalid");
            File next=new File(root,"mihomo.new");if(next.exists()&&!next.delete())throw new IOException("proxy temporary cleanup failed");
            GatewayProxyAssets.copyVerified(new BufferedInputStream(new FileInputStream(input)),next,GatewayProxyAssets.EXECUTABLE_SIZE,GatewayProxyAssets.EXECUTABLE_SHA256,GatewayProxyAssets.EXECUTABLE_SIZE);
            Os.chmod(next.getPath(),0700);if(binary.exists()&&!binary.delete())throw new IOException("proxy replacement unavailable");if(!next.renameTo(binary))throw new IOException("proxy commit failed");
            write(state,readState().put("version",GatewayProxyAssets.VERSION).put("size",GatewayProxyAssets.EXECUTABLE_SIZE)
                    .put("sha256",GatewayProxyAssets.EXECUTABLE_SHA256).put("installed_at_ms",System.currentTimeMillis()));verified=verifyInstalled();}
        return status();
    }
    synchronized JSONObject configure(JSONObject request)throws Exception {
        if(!verified)throw new IOException("proxy core unavailable");String source=request.optString("config_path"),hash=request.optString("sha256");long size=request.optLong("size");
        if(!GatewayProxyPolicy.safeSource(source)||size<2||size>GatewayProxyPolicy.MAX_CONFIG_BYTES||!hash.matches("[0-9a-f]{64}"))throw new SecurityException("proxy config request invalid");
        File input=new File(source).getCanonicalFile();if(!GatewayProxyAssets.valid(input,size,hash))throw new SecurityException("proxy config integrity mismatch");
        byte[] bytes=readBytes(input,GatewayProxyPolicy.MAX_CONFIG_BYTES);GatewayProxyPolicy.validateConfig(bytes);
        File candidate=new File(root,"config.candidate.yaml"),backup=new File(root,"config.rollback.yaml"),stateBackup=new File(root,"state.rollback.json");
        cleanup(candidate);cleanup(backup);cleanup(stateBackup);boolean wasRunning=isRunning(),hadConfig=config.isFile(),hadState=state.isFile();
        if(wasRunning)stopInternal();copy(input,candidate,size,hash);Os.chmod(candidate.getPath(),0600);
        try {
            syntax(candidate);
            if(hadConfig)copy(config,backup,config.length(),GatewayApkVerifier.sha256(config));
            if(hadState)copy(state,stateBackup,state.length(),GatewayApkVerifier.sha256(state));
            replace(candidate,config);
            JSONObject next=baseState().put("config_sha256",hash).put("config_size",size).put("configured_at_ms",System.currentTimeMillis());write(state,next);
            startInternal();JSONObject checked=testInternal();if(!checked.optBoolean("proxy_reachable"))throw new IOException("proxy connectivity unavailable");
            if(!wasRunning)stopInternal();cleanup(backup);cleanup(stateBackup);return status();
        } catch(Exception failure){
            try{stopInternal();}catch(Exception ignored){}
            if(config.exists()&&!config.delete())throw new IOException("proxy rollback cleanup failed",failure);
            if(hadConfig&&backup.exists())replace(backup,config);else cleanup(backup);
            if(state.exists()&&!state.delete())throw new IOException("proxy state rollback cleanup failed",failure);
            if(hadState&&stateBackup.exists())replace(stateBackup,state);else cleanup(stateBackup);
            if(wasRunning&&hadConfig)try{startInternal();}catch(Exception ignored){}
            throw failure;
        } finally {cleanup(candidate);cleanup(backup);cleanup(stateBackup);}
    }
    synchronized JSONObject start()throws Exception {startInternal();return testInternal();}
    synchronized JSONObject stop()throws Exception {stopInternal();return status();}
    synchronized JSONObject test()throws Exception {return testInternal();}
    synchronized JSONObject status()throws Exception {boolean configured=config.isFile();boolean running=isRunning();boolean http=running&&portOpen(GatewayProxyPolicy.HTTP_PORT),socks=running&&socksReady();JSONObject saved=readState();return new JSONObject().put("schema_version",2)
            .put("bundled",true).put("version",GatewayProxyAssets.VERSION).put("abi","arm64-v8a").put("asset_verified",true).put("core_verified",verified)
            .put("configured",configured).put("running",running).put("http_ready",http).put("socks_ready",socks)
            .put("proxy_reachable",running&&saved.optBoolean("proxy_reachable")&&http&&socks).put("management_via",GatewayProxyRoute.managementVia()).put("write_locked",true)
            .put("http_port",GatewayProxyPolicy.HTTP_PORT).put("socks_port",GatewayProxyPolicy.SOCKS_PORT).put("checked_at_ms",System.currentTimeMillis());}
    private boolean verifyInstalled()throws Exception {if(!binary.isFile()||binary.length()!=GatewayProxyAssets.EXECUTABLE_SIZE||!state.isFile())return false;
        JSONObject saved=new JSONObject(read(state,4096));
        if(!GatewayProxyAssets.VERSION.equals(saved.optString("version"))||saved.optLong("size")!=GatewayProxyAssets.EXECUTABLE_SIZE
                ||!GatewayProxyAssets.EXECUTABLE_SHA256.equals(saved.optString("sha256")))return false;
        return GatewayProxyAssets.valid(binary,GatewayProxyAssets.EXECUTABLE_SIZE,GatewayProxyAssets.EXECUTABLE_SHA256);}
    static boolean safeSource(String value){if(value==null||value.indexOf('\0')>=0)return false;
        return value.matches("/data/(?:user/0|data)/org\\.onetwoone\\.gateway/files/proxy-core/mihomo-v1\\.19\\.31");}
    private void syntax(File candidate)throws Exception {Process process=new ProcessBuilder(binary.getPath(),"-t","-d",root.getPath(),"-f",candidate.getPath()).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log)).start();
        if(!process.waitFor(25,TimeUnit.SECONDS)){process.destroyForcibly();throw new IOException("proxy syntax timeout");}if(process.exitValue()!=0)throw new IOException("proxy syntax invalid");trimLog();}
    private void startInternal()throws Exception {if(!verified||!config.isFile())throw new IOException("proxy is not configured");if(isRunning())return;cleanup(pidFile);
        String command="umask 077; echo $$ > "+quote(pidFile.getPath()+".new")+"; mv "+quote(pidFile.getPath()+".new")+" "+quote(pidFile.getPath())+"; exec "+quote(binary.getPath())+" -d "+quote(root.getPath())+" -f "+quote(config.getPath());
        child=new ProcessBuilder("/system/bin/sh","-c",command).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log)).start();
        Os.chmod(log.getPath(),0600);
        long deadline=System.currentTimeMillis()+15000;while(System.currentTimeMillis()<deadline){if(!child.isAlive())throw new IOException("proxy exited during startup");if(portOpen(GatewayProxyPolicy.HTTP_PORT)&&socksReady())return;Thread.sleep(200);}
        stopInternal();throw new IOException("proxy listener startup timeout");}
    private void stopInternal()throws Exception {int pid=readPid();if(pid>1&&identity(pid)){Os.kill(pid,OsConstants.SIGTERM);for(int n=0;n<30&&new File("/proc/"+pid).exists();n++)Thread.sleep(100);if(new File("/proc/"+pid).exists())Os.kill(pid,OsConstants.SIGKILL);}if(child!=null&&child.isAlive()){child.destroy();child.waitFor(2,TimeUnit.SECONDS);if(child.isAlive())child.destroyForcibly();}child=null;cleanup(pidFile);GatewayProxyRoute.setPreferred(false);trimLog();}
    private JSONObject testInternal()throws Exception {boolean running=isRunning(),http=running&&portOpen(GatewayProxyPolicy.HTTP_PORT),socks=running&&socksReady(),reachable=http&&httpConnect();JSONObject saved=readState();saved.put("proxy_reachable",reachable).put("last_test_ms",System.currentTimeMillis());write(state,saved);GatewayProxyRoute.setPreferred(reachable&&socks);return status();}
    private void refreshRoute(){try{JSONObject saved=readState();GatewayProxyRoute.setPreferred(isRunning()&&saved.optBoolean("proxy_reachable")&&portOpen(GatewayProxyPolicy.HTTP_PORT)&&socksReady());}catch(Exception ignored){GatewayProxyRoute.setPreferred(false);}}
    private boolean isRunning(){int pid=readPid();return pid>1&&identity(pid);}
    private int readPid(){try{return Integer.parseInt(new String(readBytes(pidFile,32),StandardCharsets.US_ASCII).trim());}catch(Exception ignored){return -1;}}
    private boolean identity(int pid){try{byte[] raw=readBytes(new File("/proc/"+pid+"/cmdline"),4096);String cmd=new String(raw,StandardCharsets.UTF_8).replace('\0',' ');return cmd.startsWith(binary.getPath()+" ")&&cmd.contains(" -f "+config.getPath());}catch(Exception ignored){return false;}}
    private static boolean portOpen(int port){try(Socket socket=new Socket()){socket.connect(new java.net.InetSocketAddress(InetAddress.getLoopbackAddress(),port),500);return true;}catch(Exception ignored){return false;}}
    private static boolean socksReady(){try(Socket socket=new Socket()){socket.connect(new java.net.InetSocketAddress(InetAddress.getLoopbackAddress(),GatewayProxyPolicy.SOCKS_PORT),500);socket.setSoTimeout(1000);socket.getOutputStream().write(new byte[]{5,1,0});byte[] answer=new byte[2];return socket.getInputStream().read(answer)==2&&answer[0]==5&&answer[1]==0;}catch(Exception ignored){return false;}}
    private static boolean httpConnect(){try(Socket socket=new Socket()){socket.connect(new java.net.InetSocketAddress(InetAddress.getLoopbackAddress(),GatewayProxyPolicy.HTTP_PORT),1000);socket.setSoTimeout(5000);socket.getOutputStream().write(("CONNECT v.elfradio.net:443 HTTP/1.1\r\nHost: v.elfradio.net:443\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));BufferedReader reader=new BufferedReader(new InputStreamReader(socket.getInputStream(),StandardCharsets.US_ASCII));String line=reader.readLine();return line!=null&&line.matches("HTTP/1\\.[01] 200(?: .*)?");}catch(Exception ignored){return false;}}
    private JSONObject baseState()throws Exception {JSONObject current=readState();return current.put("version",GatewayProxyAssets.VERSION).put("size",GatewayProxyAssets.EXECUTABLE_SIZE).put("sha256",GatewayProxyAssets.EXECUTABLE_SHA256).put("proxy_reachable",false);}
    private JSONObject readState(){try{return state.isFile()?new JSONObject(read(state,8192)):new JSONObject();}catch(Exception ignored){return new JSONObject();}}
    private static void copy(File source,File target,long size,String hash)throws Exception {try(InputStream input=new BufferedInputStream(new FileInputStream(source))){GatewayProxyAssets.copyVerified(input,target,size,hash,size);}}
    private static void replace(File source,File target)throws Exception {if(target.exists()&&!target.delete())throw new IOException("proxy replacement unavailable");if(!source.renameTo(target))throw new IOException("proxy commit failed");}
    private static byte[] readBytes(File file,long maximum)throws Exception {if(!file.isFile()||file.length()>maximum)throw new IOException("proxy file unavailable");ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[8192];try(InputStream input=new FileInputStream(file)){for(int n;(n=input.read(buffer))!=-1;){out.write(buffer,0,n);if(out.size()>maximum)throw new IOException("proxy file too large");}}return out.toByteArray();}
    private static void cleanup(File file)throws IOException {if(file.exists()&&!file.delete())throw new IOException("proxy temporary cleanup failed");}
    private static String quote(String value){return "'"+value.replace("'","'\\''")+"'";}
    private void trimLog(){try{if(log.length()>256*1024){byte[] all=readBytes(log,4L*1024*1024);int from=Math.max(0,all.length-128*1024);File next=new File(log.getPath()+".new");try(FileOutputStream out=new FileOutputStream(next)){out.write(all,from,all.length-from);out.getFD().sync();}replace(next,log);Os.chmod(log.getPath(),0600);}}catch(Exception ignored){}}
    private static String read(File file,int maximum)throws Exception {ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[1024];
        try(InputStream input=new FileInputStream(file)){for(int count;(count=input.read(buffer))!=-1;){output.write(buffer,0,count);if(output.size()>maximum)throw new IOException("proxy state too large");}}
        return output.toString("UTF-8");}
    private static void write(File file,JSONObject value)throws Exception {File next=new File(file.getPath()+".new");try(FileOutputStream output=new FileOutputStream(next)){output.write(value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));output.getFD().sync();}
        Os.chmod(next.getPath(),0600);if(file.exists()&&!file.delete())throw new IOException("proxy state replacement unavailable");if(!next.renameTo(file))throw new IOException("proxy state commit failed");}
}
