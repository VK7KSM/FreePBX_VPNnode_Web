package net.elfradio.elfremote;

import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class LostRecoveryTest {
    static class Machine implements LostRecovery.Control {
        String password="Temporary123",decrypt="0";boolean locked=true,disabled=false;
        JSONObject owner=new JSONObject();int point,failAt;boolean failed;
        void hit(){if(++point==failAt){failed=true;throw new IllegalStateException("测试中断");}}
        public boolean secure(){hit();return !password.isEmpty();}
        public boolean verify(String value){hit();return password.equals(value);}
        public void password(String value,String old){hit();assertEquals(password,old);password=value;hit();}
        public boolean locked(){hit();return locked;}
        public void dismiss(){hit();locked=false;hit();}
        public void disabled(boolean value){hit();disabled=value;hit();}
        public void owner(JSONObject value)throws Exception{hit();owner=new JSONObject(value.toString());hit();}
        public void decryptSetting(String value){hit();decrypt=value;hit();}
    }
    @Test public void everyInterruptionCanResumeWithoutLosingOriginalCredential()throws Exception {
        for(boolean secure:new boolean[]{false,true})for(int fail=0;fail<65;fail++){
            Machine m=new Machine();m.failAt=fail;
            JSONObject original=new JSONObject().put("message","原锁屏文字").put("enabled",true);
            JSONObject state=new JSONObject().put("credential","Temporary123").put("original_owner",original)
                .put("original_secure",secure).put("original_lock_disabled",!secure);
            if(secure)state.put("original_credential","Original456");
            final String[] disk={state.toString()};boolean restored=false;
            for(int retry=0;retry<4&&!restored;retry++){
                JSONObject current=new JSONObject(disk[0]);
                try{LostRecovery.restore(current,m,()->{m.hit();disk[0]=current.toString();m.hit();});restored=true;assertTrue(current.getBoolean("restored"));}
                catch(IllegalStateException expected){assertTrue(m.failed);}
            }
            assertTrue("恢复失败，故障点="+fail,restored);
            assertEquals(secure?"Original456":"",m.password);assertEquals(!secure,m.disabled);
            assertEquals(original.toString(),m.owner.toString());assertNull(m.decrypt);
            if(!secure)assertFalse(m.locked);
        }
    }
    @Test public void unknownChangedPasswordIsNotCleared()throws Exception {
        Machine m=new Machine();m.password="Unexpected789";
        JSONObject s=new JSONObject().put("credential","Temporary123").put("original_owner",new JSONObject());
        try{LostRecovery.restore(s,m,()->{});fail();}catch(IllegalStateException expected){assertEquals("lost-current-password-changed",expected.getMessage());}
        assertEquals("Unexpected789",m.password);
    }
}
