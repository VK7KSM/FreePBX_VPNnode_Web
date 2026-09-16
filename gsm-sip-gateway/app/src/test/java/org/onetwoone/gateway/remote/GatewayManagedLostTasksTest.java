package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayManagedLostTasksTest {
    @Test public void freshSampleCarriesExplicitCompletionProof()throws Exception {
        JSONObject result=GatewayManagedLostTasks.locationResult("sampled");
        assertEquals("location",result.getString("stage"));
        assertEquals("sampled",result.getString("action"));
        assertTrue(result.getBoolean("verified"));
    }

    @Test public void unsuccessfulSampleIsNeverVerified()throws Exception {
        for(String outcome:new String[]{"timeout","permission_denied","provider_unavailable","location_disabled","service_stopped"})
            assertFalse(GatewayManagedLostTasks.locationResult(outcome).getBoolean("verified"));
    }
}
