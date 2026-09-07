package net.elfradio.elfremote;

import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class AdbdScriptTest {
    private String run(boolean ipv6Fails, boolean listenerReady, int expected) throws Exception {
        String shell = System.getProperty("os.name").startsWith("Windows")
                ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
        String stubs = "v4=0; v6=0; port=-1\n"
                + "iptables() { echo \"v4 $1\" >&2; case $1 in -C) test $v4 = 1;; -I) v4=1;; -D) v4=0;; esac; }\n"
                + "ip6tables() { echo \"v6 $1\" >&2; case $1 in -C) test $v6 = 1;; -I) "
                + (ipv6Fails ? "return 9" : "v6=1") + ";; -D) v6=0;; esac; }\n"
                + "getprop() { case $1 in service.adb.tcp.port) echo \"$port\";; init.svc.adbd) echo running;; esac; }\n"
                + "setprop() { echo \"setprop $*\" >&2; port=$2; }\n"
                + "stop() { echo stop >&2; }\nstart() { echo start >&2; }\nsleep() { :; }\n"
                + "netstat() { " + (listenerReady ? "echo 'tcp 0 0 :::5555 :::* LISTEN'" : ":") + "; }\n";
        // 所有设备命令均由本进程函数替代，不能触及宿主或设备网络。
        Process process = new ProcessBuilder(shell, "-s").redirectErrorStream(true).start();
        process.getOutputStream().write((stubs + RepairPolicy.adbdCommand()).getBytes(StandardCharsets.UTF_8));
        process.getOutputStream().close();
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            fail("isolated shell timeout");
        }
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(output, expected, process.exitValue());
        return output;
    }

    @Test public void ipv6FailureDoesNotRestartDaemonAndRemovesOnlyNewIpv4Rule() throws Exception {
        String output = run(true, true, 9);
        assertTrue(output.contains("v4 -D"));
        assertFalse(output.contains("v6 -D"));
        assertFalse(output.contains("setprop"));
        assertFalse(output.contains("stop"));
        assertFalse(output.contains("ADBD_LOOPBACK_OK"));
    }

    @Test public void missingListenerRestoresPortAndBothNewRules() throws Exception {
        String output = run(false, false, 1);
        assertTrue(output.contains("setprop service.adb.tcp.port -1"));
        assertTrue(output.contains("v4 -D"));
        assertTrue(output.contains("v6 -D"));
        assertFalse(output.contains("ADBD_LOOPBACK_OK"));
    }

    @Test public void healthyListenerRequiresBothRulesBeforeRestartAndKeepsThem() throws Exception {
        String output = run(false, true, 0);
        assertTrue(output.indexOf("v6 -I") < output.indexOf("setprop"));
        assertTrue(output.contains("ADBD_LOOPBACK_OK"));
        assertFalse(output.contains("-D"));
    }
}
