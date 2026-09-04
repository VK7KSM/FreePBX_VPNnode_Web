package org.onetwoone.gateway.sip;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Minimal SIP URI parsing shared by authorization and routing code. */
public final class SipUri {
    private static final Pattern USER_PATTERN =
        Pattern.compile("(?i)sips?:([^@;>\\s]+)@");

    private SipUri() {}

    public static String extractUser(String uri) {
        if (uri == null) return "";

        Matcher matcher = USER_PATTERN.matcher(uri);
        if (matcher.find()) {
            return matcher.group(1);
        }

        String cleaned = uri.trim().replace("<", "").replace(">", "");
        if (cleaned.regionMatches(true, 0, "sips:", 0, 5)) {
            cleaned = cleaned.substring(5);
        } else if (cleaned.regionMatches(true, 0, "sip:", 0, 4)) {
            cleaned = cleaned.substring(4);
        }

        int end = cleaned.length();
        for (char delimiter : new char[] {'@', ';', ' ', '\t'}) {
            int index = cleaned.indexOf(delimiter);
            if (index >= 0 && index < end) end = index;
        }
        return cleaned.substring(0, end);
    }
}
