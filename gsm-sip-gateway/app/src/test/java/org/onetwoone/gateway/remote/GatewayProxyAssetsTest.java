package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class GatewayProxyAssetsTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    @Test public void copiesOnlyExactVerifiedArtifact()throws Exception {byte[] body="verified-proxy-core".getBytes(StandardCharsets.UTF_8);File target=new File(temporary.getRoot(),"core");
        GatewayProxyAssets.copyVerified(new ByteArrayInputStream(body),target,body.length,sha(body),body.length);assertArrayEquals(body,java.nio.file.Files.readAllBytes(target.toPath()));assertTrue(GatewayProxyAssets.valid(target,body.length,sha(body)));}
    @Test public void rejectsDigestMismatchAndRemovesOutput()throws Exception {byte[] body="corrupt".getBytes(StandardCharsets.UTF_8);File target=new File(temporary.getRoot(),"core");
        try{GatewayProxyAssets.copyVerified(new ByteArrayInputStream(body),target,body.length,sha("other".getBytes(StandardCharsets.UTF_8)),body.length);fail();}catch(SecurityException expected){}assertFalse(target.exists());}
    @Test public void rejectsOversizeInput()throws Exception {byte[] body="too-large".getBytes(StandardCharsets.UTF_8);File target=new File(temporary.getRoot(),"core");
        try{GatewayProxyAssets.copyVerified(new ByteArrayInputStream(body),target,body.length,sha(body),body.length-1);fail();}catch(IOException expected){} }
    private static String sha(byte[] body)throws Exception {StringBuilder value=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(body))value.append(String.format(Locale.ROOT,"%02x",b&255));return value.toString();}
}
