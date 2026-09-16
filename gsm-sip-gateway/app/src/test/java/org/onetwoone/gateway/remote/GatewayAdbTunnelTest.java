package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayAdbTunnelTest {
    private JSONObject request()throws Exception {String id="01234567-89ab-cdef-0123-456789abcdef";return new JSONObject().put("session_id",id)
            .put("token",new String(new char[64]).replace('\0','b')).put("expires_at",1801000).put("expires_at_unit","unix_ms")
            .put("device_url","wss://v.elfradio.net/api/elfremote/adb-tunnel/device?session_id="+id);}
    @Test public void acceptsOnlyFreshBoundBinaryRelay()throws Exception {
        assertEquals("v.elfradio.net",GatewayAdbTunnel.validate(request(),1000).getHost());
        for(String url:new String[]{"ws://v.elfradio.net/api/elfremote/adb-tunnel/device?session_id=01234567-89ab-cdef-0123-456789abcdef",
                "wss://evil.example/api/elfremote/adb-tunnel/device?session_id=01234567-89ab-cdef-0123-456789abcdef",
                "wss://v.elfradio.net/api/elfremote/adb/device?session_id=01234567-89ab-cdef-0123-456789abcdef"})
            try{GatewayAdbTunnel.validate(request().put("device_url",url),1000);fail();}catch(java.io.IOException expected){}
        try{GatewayAdbTunnel.validate(request(),1801001);fail();}catch(java.io.IOException expected){}
        try{GatewayAdbTunnel.validate(request().put("token","bad"),1000);fail();}catch(java.io.IOException expected){}
        try{GatewayAdbTunnel.validate(request().put("expires_at_unit","unix_s"),1000);fail();}catch(java.io.IOException expected){}
    }
}
