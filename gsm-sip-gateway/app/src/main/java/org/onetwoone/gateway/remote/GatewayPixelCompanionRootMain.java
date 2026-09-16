package org.onetwoone.gateway.remote;

import android.content.Context;
import android.os.Build;
import java.io.*;
import java.net.*;
import org.json.JSONObject;

/** Root-only local entry point for inspecting, staging or rolling back the Pixel companion. */
public final class GatewayPixelCompanionRootMain {
    private static final File MODULES=new File("/data/adb/modules");
    private static final File CONFIG=new File("/data/adb/elfremote-gateway/companion.conf");

    public static void main(String[] args) {
        try {
            if(android.os.Process.myUid()!=0||args.length!=3)throw new SecurityException("invalid invocation");
            String operation=args[0];if(!java.util.Arrays.asList("inspect","install-disabled","rollback").contains(operation))throw new SecurityException("invalid operation");
            JSONObject result;
            if("inspect".equals(operation))result=GatewayPixelCompanionInstaller.inspect(MODULES,CONFIG);
            else {
                requireMagisk();
                if("rollback".equals(operation))result=GatewayPixelCompanionInstaller.rollback(MODULES);
                else {
                    Context app=GatewayCoreMain.systemContext().createPackageContext("org.onetwoone.gateway",Context.CONTEXT_IGNORE_SECURITY);
                    GatewayPixelAssets.verify(app);
                    result=GatewayPixelCompanionInstaller.install(MODULES,
                            app.getAssets().open("pixel_gateway_companion/manifest.json"),
                            path->app.getAssets().open("pixel_gateway_companion/"+path),Build.DEVICE,Build.FINGERPRINT);
                }
            }
            send(args[1],args[2],new JSONObject().put("ok",true).put("result",result));System.exit(0);
        } catch(Throwable failure) {
            try{if(args.length==3)send(args[1],args[2],new JSONObject().put("ok",false).put("error",category(failure)));}catch(Exception ignored){}
            System.exit(1);
        }
    }

    static void requireMagisk() throws Exception {
        if(!MODULES.isDirectory())throw new IOException("magisk-modules-unavailable");
        Process process=new ProcessBuilder("magisk","-V").redirectErrorStream(true).start();
        if(!process.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){process.destroyForcibly();throw new IOException("magisk-unavailable");}
        String value;try(BufferedReader reader=new BufferedReader(new InputStreamReader(process.getInputStream()))){value=reader.readLine();}
        if(process.exitValue()!=0||value==null||!value.trim().matches("[0-9]{1,9}"))throw new IOException("magisk-unavailable");
    }

    private static void send(String portValue,String token,JSONObject value)throws Exception {
        int port=Integer.parseInt(portValue);if(port<1024||port>65535||!token.matches("[0-9a-f]{64}"))throw new IOException("invalid reply");
        byte[] body=value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);if(body.length<2||body.length>16384)throw new IOException("reply too large");
        try(Socket socket=new Socket(InetAddress.getByName("127.0.0.1"),port);java.io.DataOutputStream out=new java.io.DataOutputStream(socket.getOutputStream())){out.writeUTF(token);out.writeInt(body.length);out.write(body);out.flush();}
    }
    private static String category(Throwable failure){String text=String.valueOf(failure.getMessage());if(text.contains("unsupported"))return "unsupported-build";if(text.contains("magisk"))return "magisk-unavailable";if(text.contains("conflict")||text.contains("unrecognized"))return "module-conflict";if(text.contains("rollback"))return "rollback-unavailable";return "companion-operation-failed";}
    private GatewayPixelCompanionRootMain() {}
}
