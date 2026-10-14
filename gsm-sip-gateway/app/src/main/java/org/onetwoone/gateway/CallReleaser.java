package org.onetwoone.gateway;

import android.util.Log;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

/**
 * Owns every pjsua2 call object from creation until it is explicitly freed.
 *
 * <p>pjsua2's native side holds only a weak reference to the Java director object, and the
 * finalizer thread is not registered with pjlib. If the garbage collector ever finalizes a call
 * object, ~Call() runs pjsua_call_hangup() on that thread and the gateway aborts (tombstones
 * 2026-07-27, 08-23, 10-14 14:02), hanging up whatever live call owns that id. So every call object
 * is kept strongly reachable here and is only ever freed by {@link #release} on the main thread after
 * its DISCONNECTED callback. An object whose id is already reused by another call is kept forever
 * instead (a few bytes): freeing it would hang up the new call.
 */
final class CallReleaser {
    private static final String TAG = "CallReleaser";

    interface Target {
        /** True when the native call id is (again) in use by a call. */
        boolean idInUse() throws Exception;
        void free() throws Exception;
    }

    private static final Set<Object> TRACKED = Collections.newSetFromMap(new IdentityHashMap<>());

    static void track(Object owner) {
        synchronized (TRACKED) {
            TRACKED.add(owner);
        }
    }

    static boolean isTracked(Object owner) {
        synchronized (TRACKED) {
            return TRACKED.contains(owner);
        }
    }

    static int trackedCount() {
        synchronized (TRACKED) {
            return TRACKED.size();
        }
    }

    static String release(Target target, Object owner) {
        if (!isTracked(owner)) return "already";
        boolean inUse;
        try {
            inUse = target.idInUse();
        } catch (Exception e) {
            inUse = true;
        }
        if (inUse) {
            Log.w(TAG, "Call id already reused; keeping the old call object alive");
            return "parked";
        }
        try {
            target.free();
        } catch (Exception e) {
            Log.w(TAG, "Call object release failed; keeping it alive: " + e.getMessage());
            return "parked";
        }
        synchronized (TRACKED) {
            TRACKED.remove(owner);
        }
        Log.d(TAG, "Call object released, still held: " + trackedCount());
        return "released";
    }

    private CallReleaser() {}
}
