package net.elfradio.elfremote;
import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;
public class ConfigPolicyTest {
    @Test public void validatesWifiBytesAndPasswordWithoutShellInterpolation() throws Exception {
        ConfigPolicy.wifi(new JSONObject().put("ssid","测试\"$(id)").put("password","fixture-pass"));
        assertEquals("\"a\\\"b\\\\c\"",ConfigPolicy.quoteWifi("a\"b\\c"));
        try {ConfigPolicy.wifi(new JSONObject().put("ssid","测".repeat(11)));fail();}catch(IllegalArgumentException expected){}
        try {ConfigPolicy.wifi(new JSONObject().put("ssid","a").put("password","short"));fail();}catch(IllegalArgumentException expected){}
    }
    @Test public void rejectsBadContactIdentifiersAndPreservesInternationalPhone() throws Exception {
        ConfigPolicy.contact("contact_add",new JSONObject().put("name","测试").put("phone","+61 400 000 000"));
        try{ConfigPolicy.contact("contact_update",new JSONObject().put("id",0));fail();}catch(IllegalArgumentException expected){}
        ConfigPolicy.contact("contact_delete",new JSONObject().put("id",1));
    }
    @Test public void guardRestoresOnlyOriginalIdsAndCanBeCancelled() throws Exception {
        java.nio.file.Path dir=java.nio.file.Files.createTempDirectory("elf-wifi-guard-");
        for(boolean cancel:new boolean[]{false,true}) {
            if(cancel) java.nio.file.Files.write(dir.resolve("cancel"),new byte[]{1});
            String apk="/data/app/fixture's $(exit 9)/base.apk";
            String stub="app_process() { printf '%s\\n' \"$CLASSPATH\" >&2; if [ \"$3\" = check ]; then echo WIFI_API_READY; else echo \"restore $3\" >&2; fi; }\nsleep(){ :; }\n";
            Process p=new ProcessBuilder(System.getProperty("os.name").startsWith("Windows")?"C:/Program Files/Git/bin/bash.exe":"/bin/sh","-s").redirectErrorStream(true).start();
            p.getOutputStream().write((stub+WifiConnector.guardScript(dir.toString().replace('\\','/'),apk,7,"7 9 ")).getBytes(java.nio.charset.StandardCharsets.UTF_8));p.getOutputStream().close();
            assertTrue(p.waitFor(10,java.util.concurrent.TimeUnit.SECONDS));
            String output=new String(p.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
            assertEquals(output,0,p.exitValue());assertEquals(!cancel,output.contains("restore 7"));
            assertFalse(output.contains("remove_network"));
            assertTrue(output,output.contains(apk));
        }
    }
    @Test public void guardRejectsMissingOrMultilineApkPath() {
        for(String apk:new String[]{null,"","/data/app/bad\npath.apk"}) {
            try {WifiConnector.guardScript("/data/guard",apk,7,"7 ");fail();}
            catch(IllegalArgumentException expected){}
        }
    }
}
