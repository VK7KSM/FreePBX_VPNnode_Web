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
    private TextView fileStatusView;
    private Button fileInboxButton;
    private android.app.AlertDialog fileDialog;
    private android.widget.LinearLayout fileRows;
    private String fileRowsSnapshot="";
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
        fileStatusView=findViewById(R.id.fileStatusView);
        fileInboxButton=findViewById(R.id.fileInboxButton);
        fileInboxButton.setOnClickListener(v->showFiles());
        reportButton.setOnClickListener(v -> ServiceStarter.startNow(this));
        renewButton.setOnClickListener(v -> ServiceStarter.renew(this));
        permButton.setOnClickListener(v -> PermissionGate.requestIgnoreBattery(this));
        codeView.requestFocus();
        ServiceStarter.start(this);
        render();
        if(getIntent().getBooleanExtra("show_files",false))handler.post(this::showFiles);
    }

    @Override
    protected void onResume() {
        super.onResume();
        ServiceStarter.start(this);
        handler.post(refresh);
        new Thread(()->FileInbox.restore(this),"elfremote-inbox-history").start();
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(refresh);
        super.onPause();
    }

    private void render() {
        renderFiles();
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

    @Override protected void onNewIntent(android.content.Intent intent){
        super.onNewIntent(intent);setIntent(intent);if(intent.getBooleanExtra("show_files",false))showFiles();
    }
    private void renderFiles(){
        org.json.JSONArray rows=FileInbox.read(this);
        fileInboxButton.setText("接收文件"+(rows.length()>0?" · "+rows.length():""));
        org.json.JSONObject latest=rows.optJSONObject(0);
        fileStatusView.setVisibility(latest==null?View.GONE:View.VISIBLE);
        if(latest!=null)fileStatusView.setText(latest.optString("detail")+" · "+new java.io.File(latest.optString("path")).getName());
        if(fileDialog==null||!fileDialog.isShowing()||rows.toString().equals(fileRowsSnapshot))return;
        fileRowsSnapshot=rows.toString();fileRows.removeAllViews();
        if(rows.length()==0)addFileText(fileRows,"暂无接收记录",12,0xff94a3b8);
        java.text.SimpleDateFormat date=new java.text.SimpleDateFormat("MM-dd HH:mm",java.util.Locale.getDefault());
        for(int i=0;i<rows.length();i++){
            org.json.JSONObject row=rows.optJSONObject(i);if(row==null)continue;
            android.widget.LinearLayout card=new android.widget.LinearLayout(this);card.setOrientation(android.widget.LinearLayout.VERTICAL);card.setPadding(0,10,0,12);
            String path=row.optString("path");
            addFileText(card,new java.io.File(path).getName(),13,0xffe2e8f0);
            addFileText(card,row.optString("detail")+" · "+date.format(new java.util.Date(row.optLong("at"))),11,"success".equals(row.optString("state"))?0xff93c5fd:0xfff5c451);
            addFileText(card,path,11,0xff94a3b8);
            addFileText(card,String.format(java.util.Locale.getDefault(),"%.1f KB",row.optLong("bytes")/1000.0),11,0xff94a3b8);
            fileRows.addView(card);
        }
    }
    private void addFileText(android.widget.LinearLayout parent,String text,int size,int color){
        TextView v=new TextView(this);v.setText(text);v.setTextSize(size);v.setTextColor(color);v.setPadding(0,2,0,2);parent.addView(v);
    }
    private void showFiles(){
        FileInbox.seen(this);
        if(fileDialog!=null&&fileDialog.isShowing())return;
        android.widget.ScrollView scroll=new android.widget.ScrollView(this);
        fileRows=new android.widget.LinearLayout(this);fileRows.setOrientation(android.widget.LinearLayout.VERTICAL);fileRows.setPadding(18,0,18,8);scroll.addView(fileRows);
        fileDialog=new android.app.AlertDialog.Builder(this).setTitle("接收文件").setView(scroll).setPositiveButton("关闭",null).create();
        fileRowsSnapshot="";fileDialog.show();renderFiles();
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
