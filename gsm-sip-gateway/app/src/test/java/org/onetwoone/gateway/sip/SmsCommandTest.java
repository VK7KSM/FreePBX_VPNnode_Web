package org.onetwoone.gateway.sip;

import org.junit.Test;

import static org.junit.Assert.*;

public class SmsCommandTest {
    @Test
    public void parsesOneLineCommand() {
        SmsCommand command = SmsCommand.parse("SMS +61410591633: test message");
        assertNotNull(command);
        assertEquals("+61410591633", command.getDestination());
        assertEquals("test message", command.getBody());
    }

    @Test
    public void parsesMultilineBody() {
        SmsCommand command = SmsCommand.parse("SMS 13800138000:\nfirst line\nsecond line");
        assertNotNull(command);
        assertEquals("first line\nsecond line", command.getBody());
    }

    @Test
    public void rejectsImplicitOrInvalidCommands() {
        assertNull(SmsCommand.parse("13800138000 hello"));
        assertNull(SmsCommand.parse("SMS 123: hello"));
        assertNull(SmsCommand.parse("SMS 13800138000:"));
    }
}
