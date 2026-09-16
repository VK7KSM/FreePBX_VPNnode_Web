package org.onetwoone.gateway.remote;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Bounded stage log. It never receives command text, credentials, or URLs. */
final class GatewayRollingLog {
    private final File directory;private final long maxBytes;private final int files;
    GatewayRollingLog(File directory,long maxBytes,int files){this.directory=directory;this.maxBytes=maxBytes;this.files=files;}
    synchronized void write(String value){try{
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("log directory unavailable");
        String line=String.valueOf(value).replace('\n',' ').replace('\r',' ');if(line.length()>512)line=line.substring(0,512);
        byte[] bytes=(line+"\n").getBytes(StandardCharsets.UTF_8);File active=file(0);
        if(active.length()+bytes.length>maxBytes){File oldest=file(files-1);if(oldest.exists()&&!oldest.delete())throw new IOException("log delete failed");
            for(int i=files-2;i>=0;i--){File from=file(i);if(from.exists()&&!from.renameTo(file(i+1)))throw new IOException("log rotate failed");}}
        try(FileOutputStream out=new FileOutputStream(active,true)){out.write(bytes);out.flush();}
    }catch(IOException|SecurityException ignored){}}
    private File file(int index){return new File(directory,"runtime-"+index+".log");}
}
