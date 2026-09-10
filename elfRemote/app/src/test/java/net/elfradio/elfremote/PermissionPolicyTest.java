package net.elfradio.elfremote;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.file.*;
public class PermissionPolicyTest {
    @Test public void bootstrapCannotReturnReadyBeforeBatchGrant() {
        String script = WatchdogPolicy.applyCommands("/private/stage");
        assertTrue(script.indexOf("pm grant") < script.indexOf("echo BOOTSTRAP_READY"));
        assertTrue(script.contains("exit $failed\n\n) || exit $?"));
    }
    @Test public void everyInitialPermissionIsDeclaredAndAllAreGrantedInOneBatch() throws Exception {
        String manifest = new String(Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")), "UTF-8");
        String script = PermissionPolicy.commands();
        assertEquals(6, new java.util.HashSet<>(java.util.Arrays.asList(PermissionPolicy.RUNTIME)).size());
        for(String p : PermissionPolicy.RUNTIME) {
            assertTrue(manifest.contains("android:name=\"" + p + "\""));
            assertTrue(script.contains("pm grant --user 0 net.elfradio.elfremote " + p + " || failed=1"));
        }
        assertTrue(script.contains("whitelist +net.elfradio.elfremote"));
        assertFalse(script.contains("location_providers_allowed"));
        assertTrue(script.contains("RECORD_AUDIO"));
        assertFalse(script.contains("su -c"));
    }
}
