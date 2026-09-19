package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;
import java.util.Map;
import static org.junit.Assert.*;

public class SipAccountConfigTest {
    private JSONObject params()throws Exception{return new JSONObject().put("server","example.invalid").put("username","test")
            .put("password","synthetic=;[]!@").put("transport","tls");}
    @Test public void firstAccountAndTransportPreserveAudio()throws Exception{
        String out=SipAccountConfig.apply("[sip]\ndefault_proxy=-1\n[sound]\ncustom=unchanged\n",params());
        Map<String,Map<String,String>> ini=SipAccountConfig.read(out);
        assertEquals("0",ini.get("sip").get("default_proxy"));
        assertEquals("<sip:example.invalid:5061;transport=tls>",ini.get("proxy_0").get("reg_proxy"));
        assertEquals("synthetic=;[]!@",ini.get("auth_info_0").get("passwd"));
        assertEquals("unchanged",ini.get("sound").get("custom"));
    }
    @Test public void otherAccountIsPreservedAndRepeatDoesNotAddAccounts()throws Exception{
        String old="[sip]\ndefault_proxy=0\n[proxy_0]\nreg_identity=sip:other@else.invalid\nreg_sendregister=1\n[auth_info_0]\nusername=other\npasswd=synthetic-old\n";
        String out=SipAccountConfig.apply(old,params());
        Map<String,Map<String,String>> ini=SipAccountConfig.read(SipAccountConfig.apply(out,params()));
        assertEquals("1",ini.get("sip").get("default_proxy"));
        assertEquals("sip:other@else.invalid",ini.get("proxy_0").get("reg_identity"));
        assertEquals("synthetic-old",ini.get("auth_info_0").get("passwd"));
        assertFalse(ini.containsKey("proxy_2"));assertFalse(ini.containsKey("auth_info_2"));
    }
    @Test public void duplicateKeysCannotRetainOldPassword()throws Exception{
        String old="[proxy_0]\nreg_identity=sip:test@example.invalid\n[auth_info_0]\nusername=test\ndomain=example.invalid\npasswd=old1\n[auth_info_0]\npasswd=old2\nha1=stale\n";
        String out=SipAccountConfig.apply(old,params());
        assertFalse(out.contains("old1"));assertFalse(out.contains("old2"));assertFalse(out.contains("stale"));
        assertEquals(1,out.split("passwd=",-1).length-1);
    }
    @Test public void rejectsIniInjectionAndUnrepresentablePassword()throws Exception{
        for(String pass:new String[]{"x\n[sip]\ndefault_proxy=9","x\rnew=key","x\0y"," x ","x\ty"})
            assertThrows(Exception.class,()->SipAccountConfig.normalize(params().put("password",pass)));
        assertThrows(Exception.class,()->SipAccountConfig.normalize(params().put("server","example.invalid;transport=udp")));
        assertThrows(Exception.class,()->SipAccountConfig.normalize(params().put("transport","downgrade")));
    }
}
