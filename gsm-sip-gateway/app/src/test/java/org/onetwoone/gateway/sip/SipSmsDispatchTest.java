package org.onetwoone.gateway.sip;

import org.junit.Test;

import static org.junit.Assert.*;

public class SipSmsDispatchTest {
    @Test
    public void acceptsAsteriskRewriteFromAnyExtension() {
        SipSmsDispatch.Result result = SipSmsDispatch.resolve(
            "sip:102@sip.elfradio.net",
            "sip:300@sip.elfradio.net",
            "SMS +61410591633: hi");
        assertNotNull(result);
        assertEquals("+61410591633", result.phoneNumber);
        assertEquals("hi", result.body);
    }

    @Test
    public void acceptsDirectPhoneToUri() {
        SipSmsDispatch.Result result = SipSmsDispatch.resolve(
            "sip:unknown@example.com",
            "sip:0410591633@sip.elfradio.net",
            "plain text");
        assertNotNull(result);
        assertEquals("0410591633", result.phoneNumber);
        assertEquals("plain text", result.body);
    }

    @Test
    public void rejectsGatewayToWithoutCommand() {
        assertNull(SipSmsDispatch.resolve(
            "sip:102@sip.elfradio.net",
            "sip:300@sip.elfradio.net",
            "hello"));
    }
}
