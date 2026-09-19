package net.elfradio.elfremote;

import org.junit.Test;
import static org.junit.Assert.*;

public class BootstrapRootTest {
    @Test public void receiptIsUniqueReadableAndPublishedAfterOutput() {
        String s = BootstrapRoot.wrapper("/private/a'b.sh", "/private/result.out", "/private/result.rc", 10002, 1234);
        assertTrue(s.contains("-lt 1234"));
        assertTrue(s.contains("'/private/a'\\''b.sh'"));
        assertTrue(s.indexOf("code=$?") < s.indexOf("echo $code"));
        assertTrue(s.indexOf("chmod 0660") < s.indexOf("mv '/private/result.rc.tmp'"));
        assertFalse(s.contains("heal.rc"));
        assertFalse(s.contains("magisk"));
    }
    @Test public void invalidApplicationUidIsRejected() {
        try { BootstrapRoot.wrapper("a", "b", "c", 0, 123); fail(); }
        catch (IllegalArgumentException expected) { }
    }
}
