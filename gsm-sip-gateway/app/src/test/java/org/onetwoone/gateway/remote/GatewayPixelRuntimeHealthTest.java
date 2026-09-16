package org.onetwoone.gateway.remote;

import java.io.File;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
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
public class GatewayPixelRuntimeHealthTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    @Test public void emitsBoundedReadOnlyRuntimeState()throws Exception {File root=temporary.newFolder();file(root,"sys/class/power_supply/maxfg/capacity","68\n");file(root,"sys/class/power_supply/battery/temp","315\n");file(root,"sys/class/power_supply/battery/charge_disable","1\n");file(root,"sys/class/power_supply/usb/online","1\n");file(root,"sys/class/power_supply/pc_port/online","0\n");file(root,"sys/fs/selinux/enforce","1\n");Map<String,String> props=new HashMap<>();props.put("ro.product.device","crosshatch");props.put("ro.build.fingerprint","google/crosshatch/crosshatch:12/SP1A.210812.016.B2/8602260:user/release-keys");props.put("service.adb.tcp.port","5555");props.put("persist.adb.tcp.port","5555");props.put("ro.adb.secure","1");JSONObject result=GatewayPixelRuntimeHealth.snapshot(root,key->props.getOrDefault(key,""),file->new JSONObject().put("present",true).put("uid",123).put("gid",1005).put("mode",432).put("context","u:object_r:audio_device:s0"));assertTrue(result.getBoolean("supported_build"));assertTrue(result.getBoolean("selinux_enforcing"));assertTrue(result.getBoolean("write_locked"));assertEquals(68,result.getJSONObject("power").getInt("capacity"));assertTrue(result.getJSONObject("power").getBoolean("charge_disabled"));assertTrue(result.getJSONObject("adb").getBoolean("rsa_required"));assertEquals(5555,result.getJSONObject("adb").getInt("service_port"));assertEquals(3,result.getJSONObject("audio").length());}
    @Test public void missingOrInvalidValuesFailClosedWithoutPaths()throws Exception {File root=temporary.newFolder();JSONObject result=GatewayPixelRuntimeHealth.snapshot(root,key->"",file->new JSONObject().put("present",false).put("uid",JSONObject.NULL).put("gid",JSONObject.NULL).put("mode",JSONObject.NULL).put("context",JSONObject.NULL));assertFalse(result.getBoolean("supported_build"));assertTrue(result.getJSONObject("power").isNull("capacity"));assertTrue(result.getJSONObject("adb").isNull("service_port"));assertFalse(result.toString().contains(root.getPath()));}
    private static void file(File root,String relative,String value)throws Exception{File target=new File(root,relative.replace('/',File.separatorChar));assertTrue(target.getParentFile().mkdirs()||target.getParentFile().isDirectory());Files.write(target.toPath(),value.getBytes("US-ASCII"));}
}
