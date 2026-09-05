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

    @Test
    public void htmlBodyIsTreatedAsMissingApi() {
        assertEquals("控制面返回网页，配对接口未部署", Protocol.describeNonJson("<!DOCTYPE html>"));
        assertEquals("控制面返回网页，配对接口未部署", Protocol.describeNonJson("  <html lang=\"zh\">"));
        assertEquals(null, Protocol.describeNonJson("{\"ok\":true}"));
        assertEquals("空响应", Protocol.describeNonJson(""));
        assertTrue(Protocol.describeNonJson("not-json").startsWith("非JSON"));
    }

    @Test
    public void parseObjectRejectsHtmlHomepage() throws Exception {
        try {
            Protocol.parseObject("<!DOCTYPE html><title>elfRadio</title>");
            throw new AssertionError("should reject HTML");
        } catch (Exception e) {
            assertTrue(e.getMessage().contains("网页"));
        }
        assertTrue(Protocol.isOk(Protocol.parseObject("{\"ok\":true}")));
    }

    @Test
    public void formatNetErrorKeepsControlPlaneHint() {
        assertEquals(
                "控制面返回网页，配对接口未部署",
                Protocol.formatNetError(new Exception("控制面返回网页，配对接口未部署")));
    }

    @Test
    public void formatNetErrorIncludesExceptionClass() {
        String s = Protocol.formatNetError(new java.net.UnknownHostException("v.elfradio.net"));
        assertTrue(s.contains("UnknownHostException"));
        assertTrue(s.contains("v.elfradio.net"));
    }

    @Test
    public void httpFallbackRewritesHttpsOnly() {
        assertEquals(
                "http://v.elfradio.net/api/devices/enroll",
                Protocol.httpFallbackUrl("https://v.elfradio.net/api/devices/enroll"));
        assertEquals("http://example.com/x", Protocol.httpFallbackUrl("http://example.com/x"));
        assertEquals("", Protocol.httpFallbackUrl(null));
    }
}
