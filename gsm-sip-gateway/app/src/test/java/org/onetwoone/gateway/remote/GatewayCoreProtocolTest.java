package org.onetwoone.gateway.remote;

import java.io.ByteArrayInputStream;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayCoreProtocolTest {
    private static final String KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    @Test public void acceptsOnlyAuthenticatedKnownOperations() throws Exception {
        JSONObject request=new JSONObject().put("auth",KEY).put("operation","health");
        assertTrue(GatewayCoreProtocol.allowed(request,KEY));
        assertFalse(GatewayCoreProtocol.allowed(request,""));
        assertFalse(GatewayCoreProtocol.allowed(request,KEY.replace('0','1')));
        for(String operation:new String[]{"pixel-module-health","pixel-runtime-health","mobile-status","proxy-prepare","proxy-configure","proxy-start","proxy-stop","proxy-test","proxy-status","push-config","push-status","push-ack","push-hint","shutdown"}){
            request.put("operation",operation);assertTrue(GatewayCoreProtocol.allowed(request,KEY));
        }
        request.put("operation","install");assertFalse(GatewayCoreProtocol.allowed(request,KEY));
        request.put("operation","exec");assertFalse(GatewayCoreProtocol.allowed(request,KEY));
        assertFalse(GatewayCoreProtocol.allowed(new JSONObject(),KEY));
    }
    @Test public void boundedInputRejectsOversizedRequests() throws Exception {
        assertEquals("{}",GatewayCoreMain.readLine(new ByteArrayInputStream("{}\nignored".getBytes("UTF-8"))));
        try {GatewayCoreMain.readLine(new ByteArrayInputStream(new byte[16384]));fail("unbounded input");}
        catch(java.io.IOException expected) {assertEquals("frame too large",expected.getMessage());}
    }
}
