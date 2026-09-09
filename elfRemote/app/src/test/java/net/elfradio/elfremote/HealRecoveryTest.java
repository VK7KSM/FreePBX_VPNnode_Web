package net.elfradio.elfremote;

import org.junit.Test;
import java.io.File;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class HealRecoveryTest {
    private static void write(java.nio.file.Path path, String value) throws Exception { Files.write(path, value.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
    private static String read(java.nio.file.Path path) throws Exception { return new String(Files.readAllBytes(path), java.nio.charset.StandardCharsets.UTF_8); }
    @Test public void archivesOnlyProvenStaleWorkWithoutReplayingIt() throws Exception {
        for (int mode = 0; mode < 6; mode++) {
            File root = Files.createTempDirectory("heal-recovery-").toFile();
            File dir = new File(root, "tasks"), proc = new File(root, "proc"), running = new File(dir, "heal.running");
            dir.mkdirs(); new File(proc, "sys/kernel/random").mkdirs();
            write(new File(proc, "sys/kernel/random/boot_id").toPath(), "current\n");
            write(new File(proc, "uptime").toPath(), "100.00 20.00\n");
            String original = mode == 4 ? "echo unrelated\n" : "set -e; test $(date +%s) -lt 99; sync; reboot\n";
            write(running.toPath(), original);
            if (mode < 2) write(new File(dir, "heal.boot").toPath(), mode == 0 ? "previous\n" : "current\n");
            if (mode == 5) {
                new File(proc, "123").mkdirs();
                write(new File(proc, "123/cmdline").toPath(), "sh\0" + running.getPath().replace('\\', '/') + "\0");
            }
            String code = "set -e\nDIR=" + RescueFiles.quote(dir.getPath().replace('\\', '/')) + "\ndate() { echo 1000; }\nstat() { echo " + (mode == 3 ? "950" : "800") + "; }\n"
                    + HealRecovery.script().replace("/proc/", proc.getPath().replace('\\', '/') + "/");
            RebootPolicyTest.shell(code, 0);
            boolean archived = mode == 0 || mode == 2;
            assertEquals("场景 " + mode, !archived, running.isFile());
            if (archived) {
                File[] archives = new File(dir, "heal-archive").listFiles(); assertNotNull(archives); assertEquals(1, archives.length);
                assertEquals(original, read(new File(archives[0], "heal.running").toPath()));
            }
        }
    }
}
