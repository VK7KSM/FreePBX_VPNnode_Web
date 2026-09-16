package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayInstallGateTest {
    private static final String ID=GatewayUpdatePolicy.CERT;
    private JSONObject health() throws Exception {return new JSONObject().put("running",true).put("paired",true).put("busy",false)
            .put("version_code",10).put("identity_sha256",ID).put("sample_elapsed_ms",1000);}
    @Test public void requiresFreshKnownIdleState() throws Exception {
        assertTrue(GatewayInstallGate.liveIdle(health(),ID,10,1500));
        assertFalse(GatewayInstallGate.liveIdle(health(),ID,10,3001));
        assertFalse(GatewayInstallGate.liveIdle(health(),ID,10,999));
        assertFalse(GatewayInstallGate.liveIdle(health().put("busy",true),ID,10,1500));
        assertFalse(GatewayInstallGate.liveIdle(health().put("busy",JSONObject.NULL),ID,10,1500));
        assertFalse(GatewayInstallGate.liveIdle(health().put("busy","false"),ID,10,1500));
    }
    @Test public void rejectsDifferentInstanceAndMissingEvidence() throws Exception {
        assertFalse(GatewayInstallGate.liveIdle(health(),ID,11,1500));
        assertFalse(GatewayInstallGate.liveIdle(health(),"",10,1500));
        assertFalse(GatewayInstallGate.liveIdle(health().put("paired",false),ID,10,1500));
        assertFalse(GatewayInstallGate.liveIdle(health().put("running",false),ID,10,1500));
        assertFalse(GatewayInstallGate.liveIdle(null,ID,10,1500));
    }
}
