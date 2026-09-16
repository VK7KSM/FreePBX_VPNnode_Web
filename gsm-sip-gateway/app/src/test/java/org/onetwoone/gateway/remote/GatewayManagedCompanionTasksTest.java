package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayManagedCompanionTasksTest {
    private static JSONObject task()throws Exception{return new JSONObject().put("id","companion-task-1")
            .put("type","stage_pixel_companion").put("expires_at",System.currentTimeMillis()+60_000L).put("params",new JSONObject());}

    @Test public void acceptsOnlyNarrowDisabledStageContract()throws Exception {
        assertEquals("stage_pixel_companion",GatewayManagedCompanionTasks.validate(task()).getString("type"));
        JSONObject[] invalid=new JSONObject[]{task().put("type","activate_pixel_companion"),task().put("params",new JSONObject().put("charge",true)),
                task().put("expires_at",System.currentTimeMillis()+1_900_000L),task().put("id","bad id")};
        for(JSONObject value:invalid)try{GatewayManagedCompanionTasks.validate(value);fail("accepted "+value);}catch(Exception expected){}
    }

    @Test public void publishesOnlySanitizedDisabledResult()throws Exception {
        JSONObject raw=new JSONObject().put("state","installed").put("module_id","elfremote_gateway_companion")
                .put("units_enabled",false).put("rollback_available",true).put("legacy_modules","preserved")
                .put("units",units()).put("legacy",legacy());
        JSONObject result=GatewayManagedCompanionTasks.publicResult(raw);
        assertEquals(8,result.length());assertEquals("staged",result.getString("action"));assertFalse(result.getBoolean("units_enabled"));
        assertFalse(result.has("module_id"));
    }

    @Test public void rejectsEnabledOrUnknownRootResults()throws Exception {
        JSONObject base=new JSONObject().put("state","installed").put("units_enabled",false)
                .put("rollback_available",true).put("legacy_modules","preserved").put("units",units()).put("legacy",legacy());
        for(JSONObject value:new JSONObject[]{new JSONObject(base.toString()).put("units_enabled",true),
                new JSONObject(base.toString()).put("rollback_available",false),
                new JSONObject(base.toString()).put("units",units().put("audio",true)),
                new JSONObject(base.toString()).put("state","active"),new JSONObject(base.toString()).put("legacy_modules","unknown")})
            try{GatewayManagedCompanionTasks.publicResult(value);fail("accepted "+value);}catch(SecurityException expected){}
    }

    private static JSONObject units()throws Exception{return new JSONObject().put("charge",false).put("audio",false).put("adb_tcp",false);}
    private static JSONObject legacy()throws Exception{return new JSONObject()
            .put("charge_bypass",new JSONObject().put("installed",true).put("disabled",false).put("recognized",true))
            .put("sip_audio_access",new JSONObject().put("installed",true).put("disabled",false).put("recognized",true));}
}
