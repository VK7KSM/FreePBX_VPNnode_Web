package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayShareLinkTest {
    @Test public void requestCarriesIdentityAndDeduplicationId() throws Exception {
        JSONObject body = GatewayShareLink.request("dev_a", "token_b", "11111111-2222-3333-4444-555555555555");
        assertEquals("dev_a", body.getString("device_id"));
        assertEquals("token_b", body.getString("token"));
        assertEquals("11111111-2222-3333-4444-555555555555", body.getString("request_id"));
    }
    @Test public void requestRejectsMissingIdentityOrBadRequestId() {
        for (String[] args : new String[][]{{"", "t", "r"}, {"d", "", "r"}, {"d", "t", ""}, {"d", "t", "bad id"}, {"d", "t", "a/b"}})
            try { GatewayShareLink.request(args[0], args[1], args[2]); fail("应拒绝 " + java.util.Arrays.toString(args)); }
            catch (Exception expected) { }
    }
    @Test public void parseUsesServerTextAndFallsBackToUppercasedUrl() throws Exception {
        GatewayShareLink.Result withText = GatewayShareLink.parse(new JSONObject()
                .put("ok", true).put("url", "https://v.elfradio.net/s/ABCDEFGH2345").put("qr_text", "HTTPS://V.ELFRADIO.NET/S/ABCDEFGH2345").put("expires_at", 1700000000000L));
        assertEquals("HTTPS://V.ELFRADIO.NET/S/ABCDEFGH2345", withText.qrText);
        assertEquals(1700000000000L, withText.expiresAt);
        GatewayShareLink.Result without = GatewayShareLink.parse(new JSONObject().put("ok", true).put("url", "https://v.elfradio.net/s/ABCDEFGH2345"));
        assertEquals("HTTPS://V.ELFRADIO.NET/S/ABCDEFGH2345", without.qrText);
        assertEquals(0, without.expiresAt);
    }
    @Test public void parseRejectsFailureAndNonHttpsUrl() throws Exception {
        JSONObject[] replies = {null, new JSONObject(), new JSONObject().put("ok", false).put("msg", "拒绝"),
                new JSONObject().put("ok", true).put("url", "http://v.elfradio.net/s/A"), new JSONObject().put("ok", true)};
        for (JSONObject reply : replies)
            try { GatewayShareLink.parse(reply); fail("应拒绝 " + reply); } catch (Exception expected) { }
    }
    @Test public void remainingDescribesTimeLeftAndImminentExpiry() {
        assertEquals("", GatewayShareLink.remaining(0, 1000));
        assertEquals("即将过期", GatewayShareLink.remaining(1000, 1000));
        assertEquals("即将过期", GatewayShareLink.remaining(1000 + 59_000L, 1000));
        assertEquals("剩余 30 分钟", GatewayShareLink.remaining(1000 + 30 * 60_000L, 1000));
        assertEquals("剩余 1 小时 0 分钟", GatewayShareLink.remaining(1000 + 3600_000L, 1000));
        assertEquals("剩余 2 小时 5 分钟", GatewayShareLink.remaining(1000 + 2 * 3600_000L + 5 * 60_000L, 1000));
    }
}
