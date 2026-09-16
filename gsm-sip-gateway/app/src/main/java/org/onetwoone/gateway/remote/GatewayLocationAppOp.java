package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Temporarily permits this root-managed gateway to scan Wi-Fi while its UI is backgrounded. */
final class GatewayLocationAppOp {
    private static final String[] OPS={"FINE_LOCATION","COARSE_LOCATION"};
    static Scope open() throws Exception {
        String[] previous=new String[OPS.length];int changed=0;
        try {
            for(int i=0;i<OPS.length;i++){
                previous[i]=currentUid(OPS[i]);allowPackage(OPS[i]);
                if(!"allow".equals(previous[i])){setUid(OPS[i],"allow");changed=i+1;}
            }
            return new Scope(previous);
        } catch(Exception error) {
            for(int i=changed-1;i>=0;i--)try{setUid(OPS[i],previous[i]);}catch(Exception ignored){}
            throw error;
        }
    }
    private static String currentUid(String op) throws Exception {return parseUidMode(run("appops get --uid org.onetwoone.gateway "+op,true),op);}
    private static void allowPackage(String op) throws Exception {run("appops set org.onetwoone.gateway "+op+" allow",false);}
    private static void setUid(String op,String mode) throws Exception {
        if(!"FINE_LOCATION".equals(op)&&!"COARSE_LOCATION".equals(op))throw new IOException("invalid appop");
        if(!mode.matches("allow|foreground|ignore|deny|default"))throw new IOException("invalid appop mode");
        run("appops set --uid org.onetwoone.gateway "+op+" "+mode,false);
    }
    static String parseUidMode(String output,String op) throws IOException {
        if(!"FINE_LOCATION".equals(op)&&!"COARSE_LOCATION".equals(op))throw new IOException("invalid appop");
        Matcher match=Pattern.compile(Pattern.quote(op)+":\\s*(allow|foreground|ignore|deny|default)").matcher(output==null?"":output);
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
    static final class Scope implements AutoCloseable {
        private final String[] previous;private boolean closed;
        Scope(String[] previous){this.previous=previous.clone();}
        @Override public void close() throws Exception {
            if(closed)return;closed=true;Exception failure=null;
            for(int i=OPS.length-1;i>=0;i--)if(!"allow".equals(previous[i]))try{setUid(OPS[i],previous[i]);}catch(Exception error){if(failure==null)failure=error;}
            if(failure!=null)throw failure;
        }
    }
    private GatewayLocationAppOp() {}
}
