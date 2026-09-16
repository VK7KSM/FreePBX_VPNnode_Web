package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayPixelAssetsTest {
    @Test public void verifiesFrozenBundledAssets() throws Exception {
        File root=assets();
        JSONObject result=GatewayPixelAssets.verify(new FileInputStream(new File(root,"manifest.json")),
                path->new FileInputStream(new File(root,path)));
        assertTrue(result.getBoolean("verified"));assertEquals(16,result.getInt("file_count"));
        assertEquals("do_not_replace_recognized_legacy_modules",result.getString("deployment_policy"));
    }

    @Test public void rejectsChangedMissingOrTraversalAssets() throws Exception {
        File root=assets(),copy=Files.createTempDirectory("pixel-assets").toFile();copy(root,copy);
        Files.write(new File(copy,"legacy/pixel_charge_bypass/service.sh").toPath(),"changed\n".getBytes("UTF-8"));
        rejected(copy);
        copy=Files.createTempDirectory("pixel-assets-missing").toFile();copy(root,copy);
        assertTrue(new File(copy,"legacy/pixel_sip_audio_access/service.sh").delete());rejected(copy);
        String manifest=new String(Files.readAllBytes(new File(root,"manifest.json").toPath()),"UTF-8")
                .replace("legacy/pixel_charge_bypass/module.prop","../module.prop");
        try{GatewayPixelAssets.verify(new ByteArrayInputStream(manifest.getBytes("UTF-8")),path->new FileInputStream(new File(root,path)));fail();}
        catch(SecurityException expected){}
    }

    private static void rejected(File root)throws Exception {
        try{GatewayPixelAssets.verify(new FileInputStream(new File(root,"manifest.json")),path->new FileInputStream(new File(root,path)));fail();}
        catch(SecurityException|FileNotFoundException expected){}
    }
    private static File assets() throws Exception {
        File current=new File(System.getProperty("user.dir")).getCanonicalFile();
        for(int depth=0;depth<8&&current!=null;depth++,current=current.getParentFile()) {
            File direct=new File(current,"gsm-sip-gateway/app/src/main/assets/pixel_gateway_companion");
            if(new File(direct,"manifest.json").isFile())return direct;
            File candidate=new File(current,"research/FreePBX_VPNnode_Web/gsm-sip-gateway/app/src/main/assets/pixel_gateway_companion");
            if(new File(candidate,"manifest.json").isFile())return candidate;
        }
        throw new FileNotFoundException("pixel_gateway_companion/manifest.json");
    }
    private static void copy(File source,File target)throws Exception {
        File[] files=source.listFiles();if(files==null)throw new IOException("source unreadable");
        for(File file:files){File destination=new File(target,file.getName());if(file.isDirectory()){assertTrue(destination.mkdir());copy(file,destination);}
            else Files.copy(file.toPath(),destination.toPath());}
    }
}
