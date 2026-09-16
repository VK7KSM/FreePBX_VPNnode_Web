package org.onetwoone.gateway.sip;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class SipUriTest {
    @Test
    public void extractsUserFromLinphoneDisplayUri() {
        assertEquals("hiicash01", SipUri.extractUser(
            "\"hiicash01\" <sip:hiicash01@sip.linphone.org;transport=tls>"));
    }

    @Test
    public void extractsUserFromSimpleUri() {
        assertEquals("gateway01", SipUri.extractUser("sips:gateway01@sip.linphone.org"));
    }
}
