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
public class GatewayPixelCompanionInstallerTest {
    private static final String FP="google/crosshatch/crosshatch:12/SP1A.210812.016.B2/8602260:user/release-keys";
    @Rule public TemporaryFolder temporary=new TemporaryFolder();

    @Test public void installsDisabledPayloadAndIsIdempotent() throws Exception {
        File modules=temporary.newFolder("modules"),assets=assets();
        JSONObject installed=install(modules,assets,()->{});
        assertEquals("installed",installed.getString("state"));assertFalse(installed.getBoolean("units_enabled"));
        assertTrue(installed.getBoolean("rollback_available"));
        assertEquals("absent",installed.getString("legacy_modules"));
        File module=new File(modules,GatewayPixelCompanionInstaller.MODULE_ID);
        assertTrue(new File(module,".elfremote-manifest.json").isFile());
        String config=new String(Files.readAllBytes(new File(module,"default.conf").toPath()),"UTF-8");
        assertTrue(config.contains("CHARGE_ENABLED=0"));assertTrue(config.contains("AUDIO_ENABLED=0"));assertTrue(config.contains("ADB_TCP_ENABLED=0"));
        assertEquals("unchanged",install(modules,assets,()->{}).getString("state"));
        assertEquals("rolled_back_absent",GatewayPixelCompanionInstaller.rollback(modules).getString("state"));
        assertFalse(module.exists());
    }

    @Test public void preservesRecognizedLegacyModules() throws Exception {
        File modules=temporary.newFolder("legacy"),assets=assets();
        copy(new File(assets,"legacy/pixel_charge_bypass"),new File(modules,"pixel_charge_bypass"));
        copy(new File(assets,"legacy/pixel_sip_audio_access"),new File(modules,"pixel_sip_audio_access"));
        JSONObject result=install(modules,assets,()->{});
        assertEquals("preserved",result.getString("legacy_modules"));
        assertTrue(result.getJSONObject("legacy").getJSONObject("charge_bypass").getBoolean("recognized"));
        assertTrue(result.getJSONObject("legacy").getJSONObject("sip_audio_access").getBoolean("recognized"));
        assertTrue(new File(modules,"pixel_charge_bypass/service.sh").isFile());
        assertTrue(new File(modules,"pixel_sip_audio_access/sepolicy.rule").isFile());
    }

    @Test public void reportsUnitsFromEffectiveExternalConfig() throws Exception {
        File modules=temporary.newFolder("external-config"),assets=assets(),config=temporary.newFile("companion.conf");
        Files.write(config.toPath(),("SCHEMA_VERSION=1\nCHARGE_ENABLED=0\nAUDIO_ENABLED=1\nADB_TCP_ENABLED=0\n").getBytes("UTF-8"));
        JSONObject result=GatewayPixelCompanionInstaller.install(modules,manifest(assets),source(assets),"crosshatch",FP,config);
        assertTrue(result.getBoolean("units_enabled"));
        assertTrue(result.getJSONObject("units").getBoolean("audio"));
        try{GatewayManagedCompanionTasks.publicResult(result);fail("accepted enabled effective config");}catch(SecurityException expected){}
    }

    @Test public void rejectsUnknownLegacyAndWrongBuild() throws Exception {
        File modules=temporary.newFolder("conflict"),assets=assets(),legacy=new File(modules,"pixel_charge_bypass");
        assertTrue(legacy.mkdir());Files.write(new File(legacy,"module.prop").toPath(),"id=pixel_charge_bypass\n".getBytes("UTF-8"));
        rejected(()->install(modules,assets,()->{}));
        File clean=temporary.newFolder("wrong-build");
        rejected(()->GatewayPixelCompanionInstaller.install(clean,manifest(assets),source(assets),"crosshatch","unknown",()->{}));
        assertFalse(new File(clean,GatewayPixelCompanionInstaller.MODULE_ID).exists());
    }

    @Test public void restoresTrustedPreviousVersionWhenCommitFails() throws Exception {
        File modules=temporary.newFolder("rollback"),assets=assets();install(modules,assets,()->{});
        File current=new File(modules,GatewayPixelCompanionInstaller.MODULE_ID),old=new File(modules,"old-copy");copy(current,old);
        File changed=temporary.newFolder("changed-assets");copy(assets,changed);
        File config=new File(changed,"unified/default.conf");
        Files.write(config.toPath(),("SCHEMA_VERSION=1\nCHARGE_ENABLED=0\nAUDIO_ENABLED=0\nADB_TCP_ENABLED=0\nHIGH=71\nLOW=65\n").getBytes("UTF-8"));
        rewriteEntry(changed,"unified/default.conf");
        rejected(()->install(modules,changed,()->{throw new IOException("injected commit failure");}));
        assertDirectoryEquals(old,current);
        assertFalse(new File(modules,"."+GatewayPixelCompanionInstaller.MODULE_ID+".rollback").exists());
    }

    @Test public void upgradesAndExplicitlyRollsBackTrustedVersions() throws Exception {
        File modules=temporary.newFolder("upgrade"),assets=assets();install(modules,assets,()->{});
        File original=temporary.newFolder("original");
        copy(new File(modules,GatewayPixelCompanionInstaller.MODULE_ID),original);
        File changed=temporary.newFolder("upgrade-assets");copy(assets,changed);
        File config=new File(changed,"unified/default.conf");
        Files.write(config.toPath(),("SCHEMA_VERSION=1\nCHARGE_ENABLED=0\nAUDIO_ENABLED=0\nADB_TCP_ENABLED=0\nHIGH=72\nLOW=66\n").getBytes("UTF-8"));
        rewriteEntry(changed,"unified/default.conf");
        JSONObject upgraded=install(modules,changed,()->{});
        assertEquals("upgraded",upgraded.getString("state"));assertTrue(upgraded.getBoolean("rollback_available"));
        assertEquals("rolled_back",GatewayPixelCompanionInstaller.rollback(modules).getString("state"));
        assertDirectoryEquals(original,new File(modules,GatewayPixelCompanionInstaller.MODULE_ID));
    }

    private JSONObject install(File modules,File assets,GatewayPixelCompanionInstaller.Hook hook)throws Exception {
        return GatewayPixelCompanionInstaller.install(modules,manifest(assets),source(assets),"crosshatch",FP,hook);
    }
    private static InputStream manifest(File assets)throws Exception{return new FileInputStream(new File(assets,"manifest.json"));}
    private static GatewayPixelCompanionInstaller.Source source(File assets){return path->new FileInputStream(new File(assets,path));}
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
    private static void rewriteEntry(File assets,String path)throws Exception {
        File manifest=new File(assets,"manifest.json"),target=new File(assets,path);
        JSONObject value=new JSONObject(new String(Files.readAllBytes(manifest.toPath()),"UTF-8"));
        for(int i=0;i<value.getJSONArray("files").length();i++) {
            JSONObject entry=value.getJSONArray("files").getJSONObject(i);
            if(path.equals(entry.getString("path")))entry.put("size",target.length()).put("sha256",GatewayApkVerifier.sha256(target));
        }
        Files.write(manifest.toPath(),value.toString().getBytes("UTF-8"));
    }
    private static void rejected(Throwing action)throws Exception {try{action.run();fail();}catch(IOException|SecurityException expected){}}
    private interface Throwing {void run()throws Exception;}
    private static void copy(File source,File target)throws Exception {
        if(source.isDirectory()){assertTrue(target.mkdirs()||target.isDirectory());File[] children=source.listFiles();assertNotNull(children);for(File child:children)copy(child,new File(target,child.getName()));}
        else Files.copy(source.toPath(),target.toPath());
    }
    private static void assertDirectoryEquals(File expected,File actual)throws Exception {
        File[] files=expected.listFiles();assertNotNull(files);for(File file:files){File other=new File(actual,file.getName());assertEquals(file.isDirectory(),other.isDirectory());if(file.isDirectory())assertDirectoryEquals(file,other);else assertArrayEquals(Files.readAllBytes(file.toPath()),Files.readAllBytes(other.toPath()));}
    }
}
