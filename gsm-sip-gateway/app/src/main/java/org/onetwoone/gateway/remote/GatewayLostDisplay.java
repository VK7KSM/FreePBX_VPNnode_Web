package org.onetwoone.gateway.remote;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** Persistent, reversible local state for the Pixel lost-device message. */
final class GatewayLostDisplay {
    interface Launcher { void open(); void close(); }
    private static final String PREFS="gateway-lost-display";
    private final SharedPreferences state;private final Launcher launcher;

    GatewayLostDisplay(Context context){this(context.getSharedPreferences(PREFS,Context.MODE_PRIVATE),new AndroidLauncher(context));}
    GatewayLostDisplay(SharedPreferences state,Launcher launcher){this.state=state;this.launcher=launcher;}

    synchronized JSONObject show(String message)throws Exception {
        String normalized=normalize(message);boolean same=state.getBoolean("active",false)&&normalized.equals(state.getString("message",""));
        if(!same&&!state.edit().putBoolean("active",true).putString("message",normalized)
                .putLong("changed_at_ms",System.currentTimeMillis()).commit())throw new java.io.IOException("lost-display-state-unavailable");
        launcher.open();return snapshot();
    }
    synchronized JSONObject clear()throws Exception {
        if(!state.edit().putBoolean("active",false).remove("message").putLong("changed_at_ms",System.currentTimeMillis()).commit())
            throw new java.io.IOException("lost-display-state-unavailable");
        launcher.close();return snapshot();
    }
    synchronized void ensureVisible(Boolean gatewayBusy){if(state.getBoolean("active",false)&&Boolean.FALSE.equals(gatewayBusy))launcher.open();}
    synchronized JSONObject snapshot()throws Exception {return new JSONObject().put("active",state.getBoolean("active",false))
            .put("changed_at_ms",state.getLong("changed_at_ms",0)).put("message_length",state.getString("message","").length());}

    static String normalize(String value)throws Exception {
        if(value==null)throw new java.io.IOException("lost-message-invalid");
        for(int i=0;i<value.length();i++){char c=value.charAt(i);if(Character.isISOControl(c)&&c!='\n'&&c!='\r'&&c!='\t')throw new java.io.IOException("lost-message-invalid");}
        String text=value.trim();if(text.length()<1||text.length()>500)throw new java.io.IOException("lost-message-invalid");
        return text.replace("\r\n","\n").replace('\r','\n');
    }

    private static final class AndroidLauncher implements Launcher {
        private final Context context;AndroidLauncher(Context context){this.context=context.getApplicationContext();}
        public void open(){GatewayLostModeActivity.open(context);}
        public void close(){GatewayLostModeActivity.closeOpenInstance();}
    }
}
