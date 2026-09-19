package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class RebootPolicyTest {
    private JSONObject intent() throws Exception { return new JSONObject().put("format", 2).put("boot", "boot-before").put("deadline", 9000); }

    @Test public void unrelatedBootAndLegacyIntentCannotConfirmReboot() throws Exception {
        assertEquals("not-executed", RebootPolicy.outcome(intent(), "boot-after", "", false, 1000));
        assertEquals("not-executed", RebootPolicy.outcome(intent(), "boot-after", "another-boot", false, 1000));
        assertEquals("legacy-unconfirmed", RebootPolicy.outcome(new JSONObject().put("boot", "boot-before"), "boot-after", "", false, 1000));
        assertEquals("confirmed", RebootPolicy.outcome(intent(), "boot-after", "boot-before", false, 1000));
    }

    @Test public void preparationFailureAndSameBootHaveFiniteOutcome() throws Exception {
        assertEquals("waiting", RebootPolicy.outcome(intent(), "boot-before", "", false, 1000));
        assertEquals("not-executed", RebootPolicy.outcome(intent(), "boot-before", "", false, 9000));
        assertEquals("unconfirmed", RebootPolicy.outcome(intent(), "boot-before", "boot-before", false, 9000));
        assertEquals("command-failed", RebootPolicy.outcome(intent(), "boot-after", "boot-before", true, 10000));
    }

    static String shell(String code, int expected) throws Exception {
        Process process = new ProcessBuilder(System.getProperty("os.name").startsWith("Windows") ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh", "-s")
                .redirectErrorStream(true).start();
        process.getOutputStream().write(code.getBytes(StandardCharsets.UTF_8)); process.getOutputStream().close();
        if (!process.waitFor(10, TimeUnit.SECONDS)) { process.destroyForcibly(); fail("测试脚本超时"); }
        String text = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(text, expected, process.exitValue()); return text;
    }

    @Test public void executorMarksBeforeRebootAndDoesNotRunExpiredOrWrongBoot() throws Exception {
        for (int mode = 0; mode < 4; mode++) {
            File dir = Files.createTempDirectory("reboot-policy-").toFile(), marker = new File(dir, "executed");
            String cmd = RebootPolicy.command(mode == 1 ? 1000 : 9000, "boot-before", marker.getPath().replace('\\', '/'));
            String text = shell("cat() { echo " + (mode == 2 ? "boot-other" : "boot-before") + "; }\ndate() { echo 2; }\nsync() { :; }\n"
                    + "reboot() { echo REBOOT_CALLED; " + (mode == 3 ? "return 7;" : ":;") + " }\n" + cmd, mode == 1 || mode == 2 ? 1 : mode == 3 ? 7 : 0);
            assertEquals(mode == 0 || mode == 3, marker.isFile());
            assertEquals(mode == 0 || mode == 3, text.contains("REBOOT_CALLED"));
            assertEquals(mode != 0, new File(marker + ".failed").isFile());
        }
    }
}
