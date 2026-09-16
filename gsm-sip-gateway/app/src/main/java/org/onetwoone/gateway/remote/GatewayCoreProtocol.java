package org.onetwoone.gateway.remote;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

final class GatewayCoreProtocol {
    static final String SOCKET = "elfremote_gateway_core_v1";
    static final int MAX_BYTES = 16384;
    static boolean allowed(JSONObject request, String expected) {
        String supplied = request.optString("auth", "");
        return expected != null && expected.matches("[0-9a-f]{64}")
                && supplied.matches("[0-9a-f]{64}")
                && MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),supplied.getBytes(StandardCharsets.UTF_8))
                && java.util.Arrays.asList("health","pixel-module-health","mobile-status","proxy-prepare","proxy-status","push-config","push-status","push-tick","push-ack","push-hint","shutdown")
                .contains(request.optString("operation"));
    }
    private GatewayCoreProtocol() {}
}
