package net.elfradio.elfremote;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ProtocolTest {
    @Test
    public void enrollPathUsesProductionHost() {
        assertEquals("https://v.elfradio.net/api/devices/enroll", Protocol.enrollPath());
    }

    @Test
    public void parseOkFlag() throws Exception {
        assertTrue(Protocol.isOk(new JSONObject("{\"ok\":true}")));
        assertFalse(Protocol.isOk(new JSONObject("{\"ok\":false}")));
    }

    @Test
    public void tokenSha256Is64Hex() {
        String hex = PairingStore.sha256Hex("lab-token");
        assertEquals(64, hex.length());
        assertTrue(hex.matches("[0-9a-f]{64}"));
    }
}
