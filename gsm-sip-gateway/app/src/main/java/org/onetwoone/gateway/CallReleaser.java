package org.onetwoone.gateway;

import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Releases a finished pjsua2 call object exactly once.
 *
 * <p>pjsua2 does not clear a Call's id when it disconnects, and the id is reused by the next call.
 * Deleting a stale object whose id now belongs to a live call would hang that call up, so such an
 * object is parked instead: it is never freed and never finalized (a few bytes, and only when a new
 * call arrives within the release delay).
 */
final class CallReleaser {
    private static final String TAG = "CallReleaser";

    interface Target {
        /** True when the native call id is (again) in use by a call. */
        boolean idInUse() throws Exception;
        void free() throws Exception;
    }

    static final List<Object> PARKED = new ArrayList<>();
    private static final List<Object> RELEASED = new ArrayList<>();

    static String release(Target target, Object owner) {
        synchronized (PARKED) {
            if (PARKED.contains(owner) || RELEASED.contains(owner)) return "already";
        }
        boolean inUse;
        try {
            inUse = target.idInUse();
        } catch (Exception e) {
            inUse = true;
        }
        if (inUse) {
            park(owner);
            Log.w(TAG, "Call id already reused; keeping the old call object alive");
            return "parked";
        }
        try {
            target.free();
        } catch (Exception e) {
            park(owner);
            Log.w(TAG, "Call object release failed; keeping it alive: " + e.getMessage());
            return "parked";
        }
        synchronized (PARKED) {
            RELEASED.add(owner);
            if (RELEASED.size() > 64) RELEASED.remove(0);
        }
        Log.d(TAG, "Call object released");
        return "released";
    }

    private static void park(Object owner) {
        synchronized (PARKED) {
            PARKED.add(owner);
        }
    }

    private CallReleaser() {}
}
