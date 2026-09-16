package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayPixelLegacyHealthTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    @Test public void recognizesFrozenEnabledModulesWithoutWritingThem() throws Exception {
        File root=temporary.newFolder();module(root,"pixel_charge_bypass","pixel_3_XL/pixel_charge_bypass");
        module(root,"pixel_sip_audio_access","pixel_3_XL/magisk/pixel-sip-audio-access");
        long chargeTime=new File(root,"pixel_charge_bypass/service.sh").lastModified();
        JSONObject result=GatewayPixelLegacyHealth.snapshot(root);
        assertTrue(result.getBoolean("recognized"));assertTrue(result.getBoolean("enabled"));assertTrue(result.getBoolean("write_locked"));
        assertEquals("legacy_managed",result.getString("mode"));
        assertEquals(chargeTime,new File(root,"pixel_charge_bypass/service.sh").lastModified());
    }

    @Test public void reportsDisabledMissingAndUnknownModulesFailClosed() throws Exception {
        File root=temporary.newFolder();module(root,"pixel_charge_bypass","pixel_3_XL/pixel_charge_bypass");
        module(root,"pixel_sip_audio_access","pixel_3_XL/magisk/pixel-sip-audio-access");
        assertTrue(new File(root,"pixel_sip_audio_access/disable").createNewFile());
        JSONObject disabled=GatewayPixelLegacyHealth.snapshot(root);assertTrue(disabled.getBoolean("recognized"));assertFalse(disabled.getBoolean("enabled"));
        Files.write(new File(root,"pixel_charge_bypass/service.sh").toPath(),"changed\n".getBytes("UTF-8"));
        JSONObject unknown=GatewayPixelLegacyHealth.snapshot(root);assertFalse(unknown.getBoolean("recognized"));assertFalse(unknown.getBoolean("enabled"));
        module(root,"pixel_charge_bypass","pixel_3_XL/pixel_charge_bypass");
        Files.write(new File(root,"pixel_sip_audio_access/sepolicy.rule").toPath(),"changed\n".getBytes("UTF-8"));
        JSONObject policyChanged=GatewayPixelLegacyHealth.snapshot(root);assertFalse(policyChanged.getBoolean("recognized"));assertFalse(policyChanged.getBoolean("enabled"));
        delete(new File(root,"pixel_sip_audio_access"));
        JSONObject missing=GatewayPixelLegacyHealth.snapshot(root);assertFalse(missing.getBoolean("recognized"));assertFalse(missing.getBoolean("enabled"));
    }

    private static void module(File root,String id,String sourcePath) throws Exception {
        File source=fixture(sourcePath),directory=new File(root,id);if(directory.exists())delete(directory);assertTrue(directory.mkdir());
        File[] files=source.listFiles(file->file.isFile()&&java.util.Arrays.asList("module.prop","service.sh","post-fs-data.sh","sepolicy.rule").contains(file.getName()));
        assertNotNull(files);for(File file:files)Files.copy(file.toPath(),new File(directory,file.getName()).toPath());
    }
    private static File fixture(String relative) throws Exception {
        File current=new File(System.getProperty("user.dir")).getCanonicalFile();
        for(int depth=0;depth<8&&current!=null;depth++,current=current.getParentFile()) {
            File candidate=new File(current,relative);if(candidate.isDirectory())return candidate;
        }
        throw new FileNotFoundException(relative);
    }
    private static void delete(File file) {
        File[] children=file.listFiles();if(children!=null)for(File child:children)delete(child);assertTrue(file.delete());
    }
}
