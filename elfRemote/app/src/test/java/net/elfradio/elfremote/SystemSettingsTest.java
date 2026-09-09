package net.elfradio.elfremote;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class SystemSettingsTest {
    @Test public void rejectsInvalidValuesBeforeDeviceWrite()throws Exception {
        for(String input:new String[]{"{group:sound,action:set,key:brightness,value:999}","{group:network,action:set,key:mobile_data,value:'false'}","{group:apps,action:set,key:enabled,value:false}","{group:time,action:set,key:timezone,value:'invalid-zone'}"})try{SystemSettings.normalize(new JSONObject(input));fail(input);}catch(Exception expected){}
        assertEquals("test",SystemSettings.normalize(new JSONObject("{group:wifi,action:set,key:connect,value:{ssid:test,password:''}}")).getJSONObject("value").getString("ssid"));
    }
}
