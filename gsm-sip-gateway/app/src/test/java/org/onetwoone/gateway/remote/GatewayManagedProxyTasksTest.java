package org.onetwoone.gateway.remote;

import android.content.Context;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayManagedProxyTasksTest {
    private static final String HASH="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static JSONObject base(String type)throws Exception{return new JSONObject().put("id","proxy-task-1").put("type",type).put("expires_at",System.currentTimeMillis()+60000);}
    @Test public void acceptsStrictConfigureContract()throws Exception {JSONObject task=base("configure_proxy").put("params",new JSONObject()
            .put("url","https://v.elfradio.net/api/elfremote/proxy-config/proxy-task-1?device_id=device_1&token=0123456789abcdef").put("size",123).put("sha256",HASH));
        assertSame(task,GatewayManagedProxyTasks.validate(task));}
    @Test public void acceptsControlTasksWithoutParameters()throws Exception {for(String type:new String[]{"start_proxy","stop_proxy","test_proxy"})assertEquals(type,GatewayManagedProxyTasks.validate(base(type)).getString("type"));}
    @Test public void rejectsUnknownAndOverBroadContracts()throws Exception {JSONObject[] invalid=new JSONObject[]{base("unknown"),base("start_proxy").put("params",new JSONObject().put("extra",true)),
            base("configure_proxy").put("params",new JSONObject().put("url","https://evil.example/api/elfremote/proxy-config/proxy-task-1?device_id=device_1&token=0123456789abcdef").put("size",123).put("sha256",HASH)),
            base("configure_proxy").put("params",new JSONObject().put("url","https://v.elfradio.net/api/elfremote/proxy-config/proxy-task-1?device_id=device_1&token=0123456789abcdef").put("size",GatewayProxyPolicy.MAX_CONFIG_BYTES+1).put("sha256",HASH)),
            base("configure_proxy").put("params",new JSONObject().put("url","https://v.elfradio.net/api/elfremote/proxy-config/other-task?device_id=device_1&token=0123456789abcdef").put("size",123).put("sha256",HASH)),
            base("start_proxy").put("expires_at",System.currentTimeMillis()+1_900_000L)};
        for(JSONObject task:invalid)try{GatewayManagedProxyTasks.validate(task);fail("accepted "+task);}catch(Exception expected){}
    }
    @Test public void persistsLatestProxyStatusForTheNextReport()throws Exception {
        Context context=RuntimeEnvironment.getApplication();GatewayRemoteStore store=new GatewayRemoteStore(context);
        JSONObject status=new JSONObject().put("schema_version",2).put("running",true).put("management_via","proxy");
        store.prefs.edit().putString("proxy_runtime_error","stale").commit();
        GatewayManagedProxyTasks.persistStatus(store,status);
        assertEquals(status.toString(),store.prefs.getString("proxy_runtime",""));
        assertFalse(store.prefs.contains("proxy_runtime_error"));
    }
}
