package org.onetwoone.gateway.sip;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Parses explicit SMS commands sent from an authorized SIP peer. */
public final class SmsCommand {
    private static final Pattern COMMAND_PATTERN = Pattern.compile(
        "(?is)^\\s*SMS\\s+(\\+?[0-9]{10,15})\\s*:\\s*(\\S(?:.*\\S)?)\\s*$");

    private final String destination;
    private final String body;

    private SmsCommand(String destination, String body) {
        this.destination = destination;
        this.body = body;
    }

    public String getDestination() {
        return destination;
    }

    public String getBody() {
        return body;
    }

    public static SmsCommand parse(String text) {
        if (text == null) return null;
        Matcher matcher = COMMAND_PATTERN.matcher(text);
        if (!matcher.matches()) return null;
        return new SmsCommand(matcher.group(1), matcher.group(2));
    }
}
