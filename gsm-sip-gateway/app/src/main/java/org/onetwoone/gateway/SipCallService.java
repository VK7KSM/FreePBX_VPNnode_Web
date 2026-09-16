package org.onetwoone.gateway;

/**
 * Interface for services that handle SIP call callbacks.
 * Implemented by PjsipSipService.
 */
public interface SipCallService {
    /**
     * Called when SIP call state changes.
     * @param call The call
     * @param state PJSIP state (pjsip_inv_state)
     */
    void onCallState(GatewayCall call, int state);

    /**
     * Called when SIP call media state changes.
     * @param call The call
     */
    void onCallMediaState(GatewayCall call);

    /** Called for RFC2833/in-band digits received on an established SIP call. */
    void onDtmfDigit(GatewayCall call, String digit);
}
