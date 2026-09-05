package net.elfradio.elfremote;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.widget.Button;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private PairingStore store;
    private TextView codeView;
    private TextView statusView;
    private final Handler handler = new Handler();
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            render();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        store = new PairingStore(this);
        codeView = findViewById(R.id.codeView);
        statusView = findViewById(R.id.statusView);
        Button report = findViewById(R.id.reportButton);
        Button perm = findViewById(R.id.permButton);
        report.setOnClickListener(v -> {
            Intent i = new Intent(this, ReportService.class);
            i.setAction(ReportService.ACTION_REPORT_NOW);
            startService(i);
        });
        perm.setOnClickListener(v -> {
            PermissionGate.requestIgnoreBattery(this);
            PermissionGate.requestLauncherShortcut(this);
        });
        startService(new Intent(this, ReportService.class));
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(refresh);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(refresh);
        super.onPause();
    }

    private void render() {
        if (store.paired()) {
            codeView.setText("已配对");
            statusView.setText(store.lastStatus().length() == 0
                    ? getString(R.string.paired)
                    : store.lastStatus());
        } else {
            String code = store.code();
            codeView.setText(code.length() == 0 ? "------" : code);
            statusView.setText(store.lastStatus().length() == 0
                    ? getString(R.string.waiting_pair)
                    : store.lastStatus());
        }
        TextView permView = findViewById(R.id.permView);
        permView.setText(PermissionGate.ignoringBattery(this)
                ? getString(R.string.perm_ok)
                : getString(R.string.perm_need));
    }
}
