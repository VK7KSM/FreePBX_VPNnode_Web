package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayAdbSessionsTest {
    private JSONObject request()throws Exception {String id="01234567-89ab-cdef-0123-456789abcdef";return new JSONObject().put("session_id",id)
            .put("token",new String(new char[64]).replace('\0','a')).put("expires_at",61000)
            .put("url","wss://v.elfradio.net/api/elfremote/adb/device?session_id="+id);}
    @Test public void acceptsOnlyFreshBoundRelay()throws Exception {
        assertEquals("v.elfradio.net",GatewayAdbSessions.validate(request(),1000).getHost());
        for(String url:new String[]{"ws://v.elfradio.net/api/elfremote/adb/device?session_id=01234567-89ab-cdef-0123-456789abcdef",
                "wss://evil.example/api/elfremote/adb/device?session_id=01234567-89ab-cdef-0123-456789abcdef",
                "wss://v.elfradio.net/api/other?session_id=01234567-89ab-cdef-0123-456789abcdef"})
            try{GatewayAdbSessions.validate(request().put("url",url),1000);fail();}catch(java.io.IOException expected){}
        try{GatewayAdbSessions.validate(request(),61000);fail();}catch(java.io.IOException expected){}
        try{GatewayAdbSessions.validate(request().put("token","bad"),1000);fail();}catch(java.io.IOException expected){}
    }
}
