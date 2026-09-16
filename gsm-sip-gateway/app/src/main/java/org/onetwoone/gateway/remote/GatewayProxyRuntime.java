package org.onetwoone.gateway.remote;

import android.system.Os;
import java.io.*;
import org.json.JSONObject;

/** Root-owned proxy core installation and bounded status. It never starts the core by itself. */
final class GatewayProxyRuntime {
    static final String ROOT=GatewayCoreClient.DIR+"/proxy";
    private final File root=new File(ROOT),binary=new File(root,"mihomo"),state=new File(root,"state.json");
    private boolean verified;
    GatewayProxyRuntime(){try{verified=verifyInstalled();}catch(Exception ignored){verified=false;}}
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
            write(state,new JSONObject().put("version",GatewayProxyAssets.VERSION).put("size",GatewayProxyAssets.EXECUTABLE_SIZE)
                    .put("sha256",GatewayProxyAssets.EXECUTABLE_SHA256).put("installed_at_ms",System.currentTimeMillis()));verified=verifyInstalled();}
        return status();
    }
    synchronized JSONObject status()throws Exception {boolean configured=new File(root,"config.yaml").isFile();return new JSONObject().put("schema_version",1)
            .put("bundled",true).put("version",GatewayProxyAssets.VERSION).put("abi","arm64-v8a").put("asset_verified",true).put("core_verified",verified)
            .put("configured",configured).put("running",false).put("http_ready",false).put("socks_ready",false)
            .put("proxy_reachable",false).put("management_via","direct").put("write_locked",true).put("checked_at_ms",System.currentTimeMillis());}
    private boolean verifyInstalled()throws Exception {if(!binary.isFile()||binary.length()!=GatewayProxyAssets.EXECUTABLE_SIZE||!state.isFile())return false;
        JSONObject saved=new JSONObject(read(state,4096));
        if(!GatewayProxyAssets.VERSION.equals(saved.optString("version"))||saved.optLong("size")!=GatewayProxyAssets.EXECUTABLE_SIZE
                ||!GatewayProxyAssets.EXECUTABLE_SHA256.equals(saved.optString("sha256")))return false;
        return GatewayProxyAssets.valid(binary,GatewayProxyAssets.EXECUTABLE_SIZE,GatewayProxyAssets.EXECUTABLE_SHA256);}
    static boolean safeSource(String value){if(value==null||value.indexOf('\0')>=0)return false;
        return value.matches("/data/(?:user/0|data)/org\\.onetwoone\\.gateway/files/proxy-core/mihomo-v1\\.19\\.31");}
    private static String read(File file,int maximum)throws Exception {ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[1024];
        try(InputStream input=new FileInputStream(file)){for(int count;(count=input.read(buffer))!=-1;){output.write(buffer,0,count);if(output.size()>maximum)throw new IOException("proxy state too large");}}
        return output.toString("UTF-8");}
    private static void write(File file,JSONObject value)throws Exception {File next=new File(file.getPath()+".new");try(FileOutputStream output=new FileOutputStream(next)){output.write(value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));output.getFD().sync();}
        Os.chmod(next.getPath(),0600);if(file.exists()&&!file.delete())throw new IOException("proxy state replacement unavailable");if(!next.renameTo(file))throw new IOException("proxy state commit failed");}
}
