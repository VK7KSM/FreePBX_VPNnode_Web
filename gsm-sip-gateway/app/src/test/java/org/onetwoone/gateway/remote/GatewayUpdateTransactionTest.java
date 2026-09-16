package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayUpdateTransactionTest {
    static class Device implements GatewayUpdateTransaction.Platform {
        JSONObject disk;String installed="old";boolean idle=true,health=true,interrupt;
        int installs,restores,backups;
        public JSONObject read() throws Exception{return disk==null?null:new JSONObject(disk.toString());}
        public void write(JSONObject value) throws Exception{disk=new JSONObject(value.toString());}
        public boolean idle(){return idle;}
        public void backup(){backups++;}
        public void installTarget() throws Exception{installs++;installed="new";if(interrupt)throw new java.io.IOException("lost result");}
        public void installBackup(){restores++;installed="old";}
        public String installedHash(){return installed;}
        public boolean healthy(String hash){return "old".equals(hash)||health;}
        public boolean operationSettled(){return true;}
    }
    @Test public void busyNeverReplacesOrBacksUp() throws Exception {
        Device d=new Device();d.idle=false;
        assertEquals("deferred",GatewayUpdateTransaction.run(d,"task","new"));assertEquals(0,d.installs);assertEquals(0,d.backups);
        d.idle=true;assertEquals("success",GatewayUpdateTransaction.run(d,"task","new"));
        assertEquals("success",GatewayUpdateTransaction.run(d,"task","new"));assertEquals(1,d.installs);
    }
    @Test public void unhealthyTargetRestoresOriginal() throws Exception {
        Device d=new Device();d.health=false;
        assertEquals("recovered",GatewayUpdateTransaction.run(d,"task","new"));assertEquals("old",d.installed);assertEquals(1,d.restores);
    }
    @Test public void lostInstallReplyResumesWithoutReinstall() throws Exception {
        Device d=new Device();d.interrupt=true;
        assertEquals("install_pending",GatewayUpdateTransaction.run(d,"task","new"));
        assertEquals("success",GatewayUpdateTransaction.run(d,"task","new"));assertEquals(1,d.installs);
    }
    @Test public void differentTaskCannotUseExistingBackup() throws Exception {
        Device d=new Device();d.idle=false;GatewayUpdateTransaction.run(d,"task","new");
        try{GatewayUpdateTransaction.run(d,"other","new");fail();}catch(SecurityException expected){}
    }
    @Test public void outstandingPackageOperationDoesNotTriggerAnotherWrite() throws Exception {
        Device d=new Device(){
            @Override public void installTarget() throws Exception{installs++;throw new java.io.IOException("still installing");}
            @Override public boolean operationSettled(){return false;}
        };
        assertEquals("install_pending",GatewayUpdateTransaction.run(d,"task","new"));
        assertEquals("install_pending",GatewayUpdateTransaction.run(d,"task","new"));
        assertEquals(1,d.installs);assertEquals(0,d.restores);
    }
    @Test public void newCallDefersRollback() throws Exception {
        Device d=new Device(){@Override public boolean healthy(String hash){idle=false;return false;}};
        assertEquals("recovery_deferred",GatewayUpdateTransaction.run(d,"task","new"));assertEquals(0,d.restores);
    }
}
