package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Temporarily permits this root-managed gateway to scan Wi-Fi while its UI is backgrounded. */
final class GatewayLocationAppOp {
    private static final Pattern UID_MODE=Pattern.compile("FINE_LOCATION:\\s*(allow|foreground|ignore|deny|default)");
    static String currentUid() throws Exception {
        return parseUidMode(run("appops get --uid org.onetwoone.gateway FINE_LOCATION",true));
    }
    static void allowPackage() throws Exception {run("appops set org.onetwoone.gateway FINE_LOCATION allow",false);}
    static void setUid(String mode) throws Exception {
        if(!mode.matches("allow|foreground|ignore|deny|default"))throw new IOException("invalid appop mode");
        run("appops set --uid org.onetwoone.gateway FINE_LOCATION "+mode,false);
    }
    static String parseUidMode(String output) throws IOException {
        Matcher match=UID_MODE.matcher(output==null?"":output);
        if(!match.find())throw new IOException("unknown uid appop mode");
        return match.group(1);
    }
    private static String run(String command,boolean capture) throws Exception {
        java.lang.Process process=new ProcessBuilder("su","-c",command).redirectErrorStream(true).start();
        if(!process.waitFor(10,TimeUnit.SECONDS)){process.destroy();throw new IOException("location appop timeout");}
        byte[] output=read(process.getInputStream());
        if(process.exitValue()!=0)throw new IOException("location appop unavailable");
        return capture?new String(output,StandardCharsets.UTF_8):"";
    }
    private static byte[] read(InputStream input) throws IOException {
        java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[512];int count;
        while((count=input.read(buffer))>=0){if(count>0)out.write(buffer,0,count);if(out.size()>4096)throw new IOException("appops output too large");}
        return out.toByteArray();
    }
    private GatewayLocationAppOp() {}
}
