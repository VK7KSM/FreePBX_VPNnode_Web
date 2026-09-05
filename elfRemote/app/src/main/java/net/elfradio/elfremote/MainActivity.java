package net.elfradio.elfremote;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private PairingStore store;
    private TextView titleView;
    private TextView codeView;
    private TextView statusView;
    private TextView permView;
    private Button permButton;
    private Button renewButton;
    private Button reportButton;
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
        titleView = findViewById(R.id.titleView);
        codeView = findViewById(R.id.codeView);
        statusView = findViewById(R.id.statusView);
        permView = findViewById(R.id.permView);
        permButton = findViewById(R.id.permButton);
        renewButton = findViewById(R.id.renewButton);
        reportButton = findViewById(R.id.reportButton);
        reportButton.setOnClickListener(v -> ServiceStarter.startNow(this));
        renewButton.setOnClickListener(v -> ServiceStarter.renew(this));
        permButton.setOnClickListener(v -> PermissionGate.requestIgnoreBattery(this));
        codeView.requestFocus();
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
        boolean battOk = PermissionGate.ignoringBattery(this);
        permButton.setVisibility(battOk ? View.GONE : View.VISIBLE);
        if (store.paired()) {
            titleView.setText(R.string.title_paired);
            codeView.setText(R.string.code_paired);
            statusView.setText(store.lastStatus().length() == 0
                    ? getString(R.string.paired)
                    : store.lastStatus());
            permView.setText("");
            renewButton.setVisibility(View.GONE);
            reportButton.setVisibility(View.VISIBLE);
            return;
        }
        titleView.setText(R.string.title_pair);
        codeView.setText(Protocol.formatPairCode(store.code()));
        String last = store.lastStatus();
        statusView.setText(isErrorStatus(last) ? last : getString(R.string.how_to_pair));
        permView.setText(Protocol.remainingHint(store.expiresAt(), System.currentTimeMillis()));
        renewButton.setVisibility(View.VISIBLE);
        reportButton.setVisibility(View.GONE);
    }

    private static boolean isErrorStatus(String last) {
        if (last == null || last.length() == 0) return false;
        return last.contains("失败")
                || last.contains("过期")
                || last.startsWith("控制面")
                || last.startsWith("非JSON")
                || last.contains("Exception")
                || last.contains("SSL")
                || last.contains("超时");
    }
}
