package net.elfradio.elfremote;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private PairingStore store;
    private TextView codeView;
    private TextView statusView;
    private TextView permView;
    private Button permButton;
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
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);
        store = new PairingStore(this);
        codeView = findViewById(R.id.codeView);
        statusView = findViewById(R.id.statusView);
        permView = findViewById(R.id.permView);
        permButton = findViewById(R.id.permButton);
        Button report = findViewById(R.id.reportButton);
        report.setOnClickListener(v -> ServiceStarter.startNow(this));
        permButton.setOnClickListener(v -> PermissionGate.requestIgnoreBattery(this));
        report.requestFocus();
        ServiceStarter.start(this);
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        ServiceStarter.start(this);
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
        boolean battOk = PermissionGate.ignoringBattery(this);
        permView.setText(battOk ? getString(R.string.perm_ok) : getString(R.string.perm_need));
        permButton.setVisibility(battOk ? android.view.View.GONE : android.view.View.VISIBLE);
    }
}
