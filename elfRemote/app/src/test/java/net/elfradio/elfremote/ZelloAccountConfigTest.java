package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ZelloAccountConfigTest {
    @Test public void passwordIsNotTrimmedOrSentAsShell()throws Exception {
        JSONObject p=ZelloAccountConfig.normalize(new JSONObject().put("username","test-user").put("password"," test'$(synthetic) "));
        assertEquals(" test'$(synthetic) ",p.getString("password"));assertEquals("regular",p.getString("type"));
        try{ZelloAccountConfig.normalize(new JSONObject(p.toString()).put("type","work"));fail();}catch(java.io.IOException expected){}
        try{ZelloAccountConfig.normalize(new JSONObject(p.toString()).put("username","user\nnext"));fail();}catch(java.io.IOException expected){}
    }
    @Test public void authenticationNeedsFreshPasswordTokenAndServerResponse(){
        String auth="(LOGIN) Authenticating with a password\n(LOGIN) Received a new token\n(LOGIN) Server returned a buddy list";
        assertTrue(ZelloAccountConfig.authenticated(auth));
        assertTrue(ZelloAccountConfig.authenticated(auth.replace("Server returned a buddy list","Buddy list is up to date")));
        assertFalse(ZelloAccountConfig.authenticated("(LOGIN) Buddy list is up to date"));
        assertFalse(ZelloAccountConfig.authenticated("(LOGIN) Received a new token"));
        assertFalse(ZelloAccountConfig.authenticated(auth+"\n(LOGIN) Error: invalid password"));
    }
}
