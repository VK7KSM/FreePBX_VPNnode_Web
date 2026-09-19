package net.elfradio.elfremote;

import org.junit.Test;
import static org.junit.Assert.*;

public class HardwareIdentityPolicyTest {
    @Test public void acceptsGlobalAddressAndNormalizesCase() {
        assertEquals("00:11:22:aa:bb:cc",HardwareIdentityPolicy.normalize("00-11-22-AA-BB-CC"));
        assertEquals("00:11:22:aa:bb:cc",HardwareIdentityPolicy.fromBytes(new byte[]{0,17,34,(byte)170,(byte)187,(byte)204}));
    }
    @Test public void rejectsRandomMulticastPlaceholdersAndWrongLength() {
        for (String value:new String[]{"02:00:00:00:00:00","02:11:22:33:44:55","01:11:22:33:44:55","ff:ff:ff:ff:ff:ff","00:00:00:00:00:00","","garbage"})
            assertEquals("",HardwareIdentityPolicy.normalize(value));
        assertEquals("",HardwareIdentityPolicy.fromBytes(new byte[5]));
        assertEquals("",HardwareIdentityPolicy.fromBytes(new byte[7]));
    }
}
