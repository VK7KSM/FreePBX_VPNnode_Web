package org.onetwoone.gateway.sip;

/** Decides whether an inbound SIP MESSAGE should become a GSM SMS. */
public final class SipSmsDispatch {
    public static final class Result {
        public final String phoneNumber;
        public final String body;

        public Result(String phoneNumber, String body) {
            this.phoneNumber = phoneNumber;
            this.body = body;
        }
    }

    private SipSmsDispatch() {}

    /**
     * Direct To-user phone numbers still send as-is.
     * Asterisk outbound rewrite {@code SMS &lt;number&gt;: &lt;body&gt;} is accepted
     * regardless of the From extension, because the PBX already checked SMS rights.
     */
    public static Result resolve(String fromUri, String toUri, String body) {
        String toUser = SipUri.extractUser(toUri);
        if (isPhoneUser(toUser)) {
            return new Result(toUser, body == null ? "" : body);
        }
        SmsCommand command = SmsCommand.parse(body);
        if (command != null) {
            return new Result(command.getDestination(), command.getBody());
        }
        return null;
    }

    static boolean isPhoneUser(String user) {
        return user != null && user.matches("^\\+?[0-9]{10,15}$");
    }
}
