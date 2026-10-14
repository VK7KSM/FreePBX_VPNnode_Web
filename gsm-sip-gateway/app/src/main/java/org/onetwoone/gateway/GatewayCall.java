package org.onetwoone.gateway;

import android.util.Log;

import org.pjsip.pjsua2.*;

/**
 * PJSIP Call implementation for GSM-SIP Gateway.
 * Handles call state changes and media state.
 */
public class GatewayCall extends Call {
    private static final String TAG = "GatewayCall";

    private SipCallService service;
    /** Survives dispose(): the disconnect still has to be reported so the object gets released. */
    private final SipCallService owner;
    private volatile boolean disposed = false;
    private boolean disconnectReported = false;

    /**
     * Constructor for outgoing calls
     */
    public GatewayCall(SipCallService service, Account account) {
        super(account);
        this.service = service;
        this.owner = service;
        CallReleaser.track(this);
    }

    /**
     * Constructor for incoming calls
     */
    public GatewayCall(SipCallService service, Account account, int callId) {
        super(account, callId);
        this.service = service;
        this.owner = service;
        CallReleaser.track(this);
    }

    /**
     * Mark this call as disposed - no more callbacks will be processed.
     * Call this when the call is disconnected.
     */
    public void dispose() {
        disposed = true;
        service = null;
        Log.d(TAG, "Call disposed");
    }

    public boolean isDisposed() {
        return disposed;
    }

    @Override
    public void onCallState(OnCallStateParam prm) {
        int state = -1;
        String stateText = "";
        try {
            CallInfo info = getInfo();
            state = info.getState();
            stateText = info.getStateText();
        } catch (Exception e) {
            Log.e(TAG, "Error reading call state: " + e.getMessage());
        }
        boolean disconnected = state == pjsip_inv_state.PJSIP_INV_STATE_DISCONNECTED;

        // 2026-10-14: pjsua2 frees this call's media objects before this callback, and the native
        // call id is reused by the next call. Tell the owner first so nothing touches the freed
        // media, even when the call was already disposed by our own hangup.
        if (disconnected && !disconnectReported && owner != null) {
            disconnectReported = true;
            owner.onCallDisconnected(this);
        }

        if (disposed) {
            Log.d(TAG, "Ignoring onCallState - call disposed");
            return;
        }

        try {
            Log.d(TAG, "Call state: " + stateText + " (" + state + ")");

            // Mark as disposed on disconnect to prevent further callbacks
            if (disconnected) {
                disposed = true;
            }

            if (service != null) {
                service.onCallState(this, state);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error in onCallState: " + e.getMessage());
        }
    }

    /**
     * Free the native call object. Must run on a pjlib-registered thread after the DISCONNECTED
     * callback has returned (the owner posts it to the main thread).
     *
     * <p>Leaving it to the garbage collector crashed the gateway: the finalizer thread is not
     * registered with pjlib, and ~Call() hangs up whatever call currently owns the reused id,
     * i.e. the next, live call (tombstones 2026-07-27, 08-23, 10-14 14:02).
     */
    public String release() {
        return CallReleaser.release(new CallReleaser.Target() {
            @Override public boolean idInUse() { return getId() >= 0 && isActive(); }
            @Override public void free() { delete(); }
        }, this);
    }

    @Override
    public void onCallMediaState(OnCallMediaStateParam prm) {
        if (disposed) {
            Log.d(TAG, "Ignoring onCallMediaState - call disposed");
            return;
        }

        Log.d(TAG, "Media state changed");

        try {
            if (service != null) {
                service.onCallMediaState(this);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error in onCallMediaState: " + e.getMessage());
        }
    }

    @Override
    public void onCallTransferRequest(OnCallTransferRequestParam prm) {
        Log.d(TAG, "Transfer request: " + prm.getDstUri());
        // Reject transfers for now
        prm.setStatusCode(pjsip_status_code.PJSIP_SC_DECLINE);
    }

    @Override
    public void onCallReplaced(OnCallReplacedParam prm) {
        Log.d(TAG, "Call replaced by " + prm.getNewCallId());
    }

    @Override
    public void onInstantMessage(OnInstantMessageParam prm) {
        Log.d(TAG, "IM: " + prm.getMsgBody());
    }

    @Override
    public void onDtmfDigit(OnDtmfDigitParam prm) {
        String digit = prm.getDigit();
        Log.d(TAG, "DTMF: " + digit);
        if (!disposed && service != null) {
            service.onDtmfDigit(this, digit);
        }
    }
}
