package org.onetwoone.gateway.remote;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** One-shot root command helper with bounded output, timeout and cancellation. */
public final class GatewayExecRootMain {
    private static final int MAX_OUTPUT=16000;
    public static void main(String[] args){
        try{if(android.os.Process.myUid()!=0||args.length!=4||!"exec".equals(args[0]))throw new SecurityException("invalid invocation");File request=request(args[1]);JSONObject result=run(read(request),new File(request.getParentFile(),"cancel"));GatewayUpdateProgress.write(new File(request.getParentFile(),"result.json"),result);send(args[2],args[3],new JSONObject().put("ok",true).put("result",result));System.exit(0);}
        catch(Throwable failure){try{if(args.length==4)send(args[2],args[3],new JSONObject().put("ok",false).put("error",failure.getClass().getSimpleName()));}catch(Exception ignored){}System.exit(1);}
    }
    static JSONObject normalize(JSONObject input)throws Exception{
        if(input==null||input.length()!=3)throw new IOException("invalid command");String command=input.getString("command"),cwd=input.getString("cwd");int timeout=input.getInt("timeout");
        if(command.isEmpty()||command.length()>8192||command.indexOf('\0')>=0)throw new IOException("invalid command");
        if(!cwd.startsWith("/")||cwd.length()>1024||cwd.indexOf('\0')>=0)throw new IOException("invalid cwd");
        if(timeout<1||timeout>120)throw new IOException("invalid timeout");return new JSONObject().put("command",command).put("cwd",cwd).put("timeout",timeout);
    }
    static JSONObject run(JSONObject raw,File cancel)throws Exception{
        JSONObject input=normalize(raw);long started=android.os.SystemClock.elapsedRealtime();Process process=new ProcessBuilder("/system/bin/sh","-c","cd "+quote(input.getString("cwd"))+" || exit 125\n"+input.getString("command")).redirectErrorStream(true).start();
        BoundedOutput output=new BoundedOutput();Thread reader=new Thread(()->output.read(process.getInputStream()),"gateway-exec-output");reader.start();String action="completed";int timeout=input.getInt("timeout");long deadline=started+timeout*1000L;
        while(process.isAlive()&&android.os.SystemClock.elapsedRealtime()<deadline&&!cancel.exists())Thread.sleep(100);
        if(process.isAlive()){action=cancel.exists()?"cancelled":"timed_out";process.destroy();if(!process.waitFor(2,TimeUnit.SECONDS))process.destroyForcibly();}
        process.waitFor();reader.join(2000);int exit=process.exitValue();return new JSONObject().put("output",output.text()).put("truncated",output.truncated)
                .put("exit_code",exit).put("elapsed_ms",Math.max(0,android.os.SystemClock.elapsedRealtime()-started)).put("action",action);
    }
    private static File request(String value)throws Exception{File file=new File(value).getCanonicalFile();String path=file.getPath().replace('\\','/');if(!path.matches("/data/(?:user/0|data)/org\\.onetwoone\\.gateway/files/gateway-exec-tasks/[0-9a-f]{64}/request\\.json")||!file.isFile()||file.length()<2||file.length()>12288)throw new SecurityException("invalid request");return file;}
    private static JSONObject read(File file)throws Exception{byte[] bytes=new byte[(int)file.length()];try(InputStream in=new FileInputStream(file)){int at=0,n;while(at<bytes.length&&(n=in.read(bytes,at,bytes.length-at))>0)at+=n;if(at!=bytes.length)throw new EOFException();}return normalize(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));}
    private static void send(String portValue,String token,JSONObject value)throws Exception{int port=Integer.parseInt(portValue);if(port<1024||port>65535||!token.matches("[0-9a-f]{64}"))throw new IOException("invalid reply");byte[] body=value.toString().getBytes(StandardCharsets.UTF_8);if(body.length<2||body.length>20000)throw new IOException("reply too large");try(Socket socket=new Socket(InetAddress.getByName("127.0.0.1"),port);DataOutputStream out=new DataOutputStream(socket.getOutputStream())){out.writeUTF(token);out.writeInt(body.length);out.write(body);out.flush();}}
    private static String quote(String value){return "'"+value.replace("'","'\\''")+"'";}
    private static final class BoundedOutput{private final ByteArrayOutputStream kept=new ByteArrayOutputStream();private boolean truncated;void read(InputStream in){byte[] buffer=new byte[4096];try{int n;while((n=in.read(buffer))!=-1){synchronized(this){int room=MAX_OUTPUT-kept.size(),copy=Math.min(room,n);if(copy>0)kept.write(buffer,0,copy);if(copy<n)truncated=true;}}}catch(IOException ignored){}}synchronized String text(){return new String(kept.toByteArray(),StandardCharsets.UTF_8);}}
    private GatewayExecRootMain(){}
}
