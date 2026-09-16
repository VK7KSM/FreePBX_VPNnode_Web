package org.onetwoone.gateway.remote;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayProxyConfigStageTest {
    @Test public void stagesOnlyDigestNamedVerifiedConfig()throws Exception {byte[] body="allow-lan: false\n".getBytes(StandardCharsets.UTF_8);String hash=hex(body);
        java.io.File result=GatewayProxyConfigStage.stage(RuntimeEnvironment.getApplication(),new ByteArrayInputStream(body),body.length,hash);
        assertEquals(hash+".yaml",result.getName());assertEquals(body.length,result.length());assertTrue(GatewayProxyAssets.valid(result,body.length,hash));
    }
    @Test public void rejectsIncorrectDigest()throws Exception {byte[] body="config".getBytes(StandardCharsets.UTF_8);
        try{GatewayProxyConfigStage.stage(RuntimeEnvironment.getApplication(),new ByteArrayInputStream(body),body.length,hex("other".getBytes(StandardCharsets.UTF_8)));fail();}catch(SecurityException expected){}
    }
    private static String hex(byte[] body)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(body))out.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return out.toString();}
}
