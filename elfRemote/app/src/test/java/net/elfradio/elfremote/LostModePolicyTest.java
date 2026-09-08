package net.elfradio.elfremote;
import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;
public class LostModePolicyTest {
    @Test public void messageIsRequiredOnlyWhenEnabling() throws Exception {
        assertEquals("测试",LostModePolicy.params(new JSONObject().put("enabled",true).put("message"," 测试 ")).getString("message"));
        assertEquals("",LostModePolicy.params(new JSONObject().put("enabled",false).put("message","old")).getString("message"));
        for(JSONObject bad:new JSONObject[]{new JSONObject().put("enabled","true"),new JSONObject().put("enabled",true),new JSONObject().put("enabled",true).put("message","x".repeat(301))}) {
            try{LostModePolicy.params(bad);fail();}catch(IllegalArgumentException expected){}
        }
    }
}
