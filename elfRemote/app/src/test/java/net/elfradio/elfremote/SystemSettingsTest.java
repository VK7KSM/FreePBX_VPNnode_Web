package net.elfradio.elfremote;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
public class SystemSettingsTest {
    @Test public void rejectsInvalidValuesBeforeDeviceWrite()throws Exception {
        for(String input:new String[]{"{group:sound,action:set,key:brightness,value:999}","{group:network,action:set,key:mobile_data,value:'false'}","{group:apps,action:set,key:enabled,value:false}","{group:time,action:set,key:timezone,value:'invalid-zone'}"})try{SystemSettings.normalize(new JSONObject(input));fail(input);}catch(Exception expected){}
        assertEquals("test",SystemSettings.normalize(new JSONObject("{group:wifi,action:set,key:connect,value:{ssid:test,password:''}}")).getJSONObject("value").getString("ssid"));
    }
    @Test public void recoveryJournalSurvivesRestartButCommittedOrRestoredDoesNotReplay()throws Exception {
        java.io.File folder=java.nio.file.Files.createTempDirectory("settings-journal").toFile();
        try {
            assertFalse(SystemSettings.needsRecovery(folder));
            RescueFiles.write(new java.io.File(folder,"settings-network-before.json"),"{}");assertTrue(SystemSettings.needsRecovery(folder));
            java.io.File commit=new java.io.File(folder,"settings-commit");RescueFiles.write(commit,"ok");assertFalse(SystemSettings.needsRecovery(folder));
            commit.delete();RescueFiles.write(new java.io.File(folder,"settings-restored"),"restored");assertFalse(SystemSettings.needsRecovery(folder));
            try{SystemSettings.normalize(new JSONObject("{group:network,action:set,key:dns,value:{mode:auto}}"));fail();}catch(java.io.IOException expected){}
        }finally{for(java.io.File f:folder.listFiles())f.delete();folder.delete();}
    }
    @Test public void oldFailedNetworkJournalCannotOverrideLaterConfirmedNetwork()throws Exception {
        java.io.File root=java.nio.file.Files.createTempDirectory("network-journals").toFile();
        java.io.File old=new java.io.File(root,"old"),latest=new java.io.File(root,"latest");old.mkdir();latest.mkdir();
        try{
            java.io.File a=new java.io.File(old,"settings-network-before.json"),b=new java.io.File(latest,"settings-network-before.json");
            RescueFiles.write(a,"{}");a.setLastModified(1000);RescueFiles.write(b,"{}");b.setLastModified(2000);
            assertEquals(latest,SystemSettings.pendingNetworkRecovery(root));
            RescueFiles.write(new java.io.File(latest,"settings-commit"),"ok");assertNull(SystemSettings.pendingNetworkRecovery(root));
            assertTrue(SystemSettings.needsRecovery(old));
        }finally{for(java.io.File d:root.listFiles()){for(java.io.File f:d.listFiles())f.delete();d.delete();}root.delete();}
    }
}
