package org.onetwoone.gateway.remote;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** One-shot root helper for structured file operations. */
public final class GatewayFileRootMain {
    public static void main(String[] args){
        try{
            if(android.os.Process.myUid()!=0||args.length!=4||!"manage".equals(args[0]))throw new SecurityException("invalid invocation");
            File request=request(args[1]);JSONObject result=GatewayFileOperations.run(read(request),new File(request.getParentFile(),"cancel"));send(args[2],args[3],new JSONObject().put("ok",true).put("result",result));System.exit(0);
        }catch(Throwable failure){try{if(args.length==4)send(args[2],args[3],new JSONObject().put("ok",false).put("error",failure.getClass().getSimpleName()));}catch(Exception ignored){}System.exit(1);}
    }
    private static File request(String value)throws Exception {File file=new File(value).getCanonicalFile();String path=file.getPath().replace('\\','/');if(!path.matches("/data/(?:user/0|data)/org\\.onetwoone\\.gateway/files/gateway-file-tasks/[0-9a-f]{64}/request\\.json")||!file.isFile()||file.length()<2||file.length()>8192)throw new SecurityException("invalid request");return file;}
    private static JSONObject read(File file)throws Exception {byte[] bytes=new byte[(int)file.length()];try(InputStream in=new FileInputStream(file)){int at=0,n;while(at<bytes.length&&(n=in.read(bytes,at,bytes.length-at))>0)at+=n;if(at!=bytes.length)throw new EOFException();}return new JSONObject(new String(bytes,StandardCharsets.UTF_8));}
    private static void send(String portValue,String token,JSONObject value)throws Exception {int port=Integer.parseInt(portValue);if(port<1024||port>65535||!token.matches("[0-9a-f]{64}"))throw new IOException("invalid reply");byte[] body=value.toString().getBytes(StandardCharsets.UTF_8);if(body.length<2||body.length>16384)throw new IOException("reply too large");try(Socket socket=new Socket(InetAddress.getByName("127.0.0.1"),port);DataOutputStream out=new DataOutputStream(socket.getOutputStream())){out.writeUTF(token);out.writeInt(body.length);out.write(body);out.flush();}}
    private GatewayFileRootMain(){}
}
