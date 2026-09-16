package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayPixelCompanionControllerTest {
    @Test public void installRequiresConfirmedIdleAndDisabledResult()throws Exception {
        List<String> calls=new ArrayList<>();GatewayPixelCompanionController controller=new GatewayPixelCompanionController(operation->{calls.add(operation);return disabled();});
        rejected(()->controller.installDisabled(null));rejected(()->controller.installDisabled(true));assertTrue(calls.isEmpty());
        assertEquals("installed",controller.installDisabled(false).getString("state"));assertEquals(java.util.Arrays.asList("install-disabled"),calls);
        GatewayPixelCompanionController unsafe=new GatewayPixelCompanionController(operation->disabled().put("units_enabled",true));
        try{unsafe.installDisabled(false);fail();}catch(SecurityException expected){}
    }
    @Test public void rollbackRequiresIdleAndInspectIsReadOnly()throws Exception {
        List<String> calls=new ArrayList<>();GatewayPixelCompanionController controller=new GatewayPixelCompanionController(operation->{calls.add(operation);return disabled();});
        controller.inspect();rejected(()->controller.rollback(true));controller.rollback(false);
        assertEquals(java.util.Arrays.asList("inspect","rollback"),calls);
    }
    private static JSONObject disabled()throws Exception{return new JSONObject().put("state","installed").put("units_enabled",false);}
    private static void rejected(Throwing action)throws Exception{try{action.run();fail();}catch(IOException expected){}}
    private interface Throwing{void run()throws Exception;}
}
