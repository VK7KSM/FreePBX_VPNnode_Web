package org.onetwoone.gateway.remote;

import android.app.Activity;
import android.os.Bundle;
import android.content.SharedPreferences;
import android.widget.*;
import org.onetwoone.gateway.R;

public final class GatewayRemoteActivity extends Activity implements SharedPreferences.OnSharedPreferenceChangeListener {
    private GatewayRemoteStore store;
    private TextView status;
    private TextView code;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        setTitle("elfRemote Gateway");
        store = new GatewayRemoteStore(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        content.setPadding(padding,padding,padding,padding);
        TextView title=new TextView(this); title.setText("elfRemote Gateway"); title.setTextSize(24);
        title.setPadding(0,0,0,padding); content.addView(title);
        status = new TextView(this); status.setTextSize(18); content.addView(status);
        code = new TextView(this); code.setTextSize(32); code.setPadding(0,padding,0,padding); content.addView(code);
        Button connect = new Button(this); connect.setText(R.string.remote_connect);
        connect.setOnClickListener(v -> {
            store.prefs.edit().putBoolean("enabled",true).apply();
            GatewayRemoteService.start(this);
        });
        content.addView(connect);
        ScrollView scroll = new ScrollView(this); scroll.addView(content); setContentView(scroll);
    }
    @Override protected void onResume() { super.onResume(); store.prefs.registerOnSharedPreferenceChangeListener(this); render(); }
    @Override protected void onPause() { store.prefs.unregisterOnSharedPreferenceChangeListener(this); super.onPause(); }
    @Override public void onSharedPreferenceChanged(SharedPreferences prefs,String key) { runOnUiThread(this::render); }
    private void render() {
        boolean paired = store.prefs.getBoolean("paired",false);
        String error = store.prefs.getString("last_error", "");
        long report = store.prefs.getLong("last_report",0);
        status.setText(getString(paired ? R.string.remote_paired : R.string.remote_pair_pending) + "\n"
                + (report==0 ? getString(R.string.remote_no_report) : getString(R.string.remote_last_report,android.text.format.DateFormat.format("MM-dd HH:mm:ss",report)))
                + (error.isEmpty() ? "" : "\n"+getString(R.string.remote_error,error))
                + "\n"+getString(R.string.remote_core, getString(store.prefs.getBoolean("core_ready",false)?R.string.remote_running:R.string.remote_not_ready)));
        code.setText(paired ? "" : (store.enrollmentExpired() ? "" : store.prefs.getString("code","")));
    }
}
