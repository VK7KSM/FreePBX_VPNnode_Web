package org.onetwoone.gateway.remote;

import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayProxyConfigDownloadTest {
    @Test public void acceptsOnlySameOriginDedicatedRoute()throws Exception {
        assertEquals("v.elfradio.net",GatewayProxyConfigDownload.validateUrl("https://v.elfradio.net/api/elfremote/proxy-config/task-1?device_id=device_1&token=0123456789abcdef").getHost());
        for(String value:new String[]{"http://v.elfradio.net/api/elfremote/proxy-config/task-1","https://evil.example/api/elfremote/proxy-config/task-1","https://v.elfradio.net/api/devices/report","https://user@v.elfradio.net/api/elfremote/proxy-config/task-1","https://v.elfradio.net/api/elfremote/proxy-config/task-1#fragment","https://v.elfradio.net/api/elfremote/proxy-config/../devices/report","https://v.elfradio.net/api/elfremote/proxy-config/%2e%2e"}){
            try{GatewayProxyConfigDownload.validateUrl(value);fail("accepted "+value);}catch(SecurityException expected){}
        }
    }
}
