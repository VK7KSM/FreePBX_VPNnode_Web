package net.elfradio.elfremote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import net.elfradio.elfremote.qr.QrCode;
import org.json.JSONObject;
import java.util.UUID;

/** 设备自助生成本机管理链接：向服务器申请（默认一小时免密），本地生成二维码，只含网址。 */
final class ShareLink {
    static String path() { return Protocol.BASE_URL + "/api/devices/share-link"; }

    /** 请求体：设备身份 + 本次点击的请求编号（重试去重）。 */
    static JSONObject request(String deviceId, String token, String requestId) throws Exception {
        return new JSONObject().put("device_id", deviceId).put("token", token).put("request_id", requestId);
    }

    /** 服务器返回的展示信息。 */
    static final class Result {
        final String url, qrText; final long expiresAt;
        Result(String url, String qrText, long expiresAt) { this.url = url; this.qrText = qrText; this.expiresAt = expiresAt; }
    }
    static Result parse(String body) throws Exception {
        JSONObject x = new JSONObject(body);
        if (!x.optBoolean("ok")) throw new Exception(x.optString("msg", "链接生成失败"));
        String url = x.getString("url");
        return new Result(url, x.optString("qr_text", url.toUpperCase()), x.optLong("expires_at", 0));
    }

    /** 全大写网址走字母数字模式，纠错 M；240 像素屏上版本 2 每格约 8 像素。 */
    static Bitmap qrBitmap(String text, int sizePx) {
        QrCode qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
        int quiet = 2, n = qr.size + quiet * 2, cell = Math.max(1, sizePx / n), px = n * cell;
        Bitmap bmp = Bitmap.createBitmap(px, px, Bitmap.Config.RGB_565);
        int[] row = new int[px];
        for (int y = 0; y < px; y++) {
            int my = y / cell - quiet;
            for (int x = 0; x < px; x++) { int mx = x / cell - quiet; row[x] = qr.getModule(mx, my) ? Color.BLACK : Color.WHITE; }
            bmp.setPixels(row, 0, px, 0, y, px, 1);
        }
        return bmp;
    }

    static void generate(Activity activity, PairingStore store) {
        if (!store.paired()) { Toast.makeText(activity, "尚未配对", Toast.LENGTH_SHORT).show(); return; }
        Toast.makeText(activity, "正在生成管理链接…", Toast.LENGTH_SHORT).show();
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            try {
                String body = HttpJson.post(path(), request(store.deviceId(), store.token(), UUID.randomUUID().toString()).toString());
                Result result = parse(body);
                RuntimeLog.event("share_link_created expires_at=" + result.expiresAt);
                main.post(() -> show(activity, result));
            } catch (Exception error) {
                RuntimeLog.error("share_link_failed", error);
                main.post(() -> Toast.makeText(activity, "生成失败：" + Protocol.formatNetError(error), Toast.LENGTH_LONG).show());
            }
        }, "elfremote-share-link").start();
    }

    private static void show(Activity activity, Result result) {
        if (activity.isFinishing()) return;
        float dp = activity.getResources().getDisplayMetrics().density;
        int screen = Math.min(activity.getResources().getDisplayMetrics().widthPixels, activity.getResources().getDisplayMetrics().heightPixels);
        int qrPx = Math.max(120, Math.min(screen - (int) (48 * dp), 400));
        LinearLayout box = new LinearLayout(activity); box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (8 * dp); box.setPadding(pad, pad, pad, pad); box.setBackgroundColor(Color.WHITE);
        ImageView image = new ImageView(activity); image.setImageBitmap(qrBitmap(result.qrText, qrPx)); image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setLayoutParams(new LinearLayout.LayoutParams(qrPx, qrPx)); ((LinearLayout.LayoutParams) image.getLayoutParams()).gravity = android.view.Gravity.CENTER_HORIZONTAL;
        box.addView(image);
        TextView text = new TextView(activity); text.setText(result.url); text.setTextColor(Color.BLACK); text.setTextSize(11); text.setPadding(0, pad, 0, 0); text.setTextIsSelectable(true);
        box.addView(text);
        TextView hint = new TextView(activity); hint.setTextColor(Color.DKGRAY); hint.setTextSize(10);
        hint.setText(result.expiresAt > 0 ? "免密，" + Protocol.remainingHint(result.expiresAt, System.currentTimeMillis()) + "，可在网页“设置”里改密码与有效期" : "免密");
        box.addView(hint);
        new AlertDialog.Builder(activity).setTitle("管理链接").setView(box)
                .setPositiveButton("复制链接", (d, w) -> {
                    ClipboardManager clip = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clip != null) { clip.setPrimaryClip(ClipData.newPlainText("elfRemote 管理链接", result.url)); Toast.makeText(activity, "已复制", Toast.LENGTH_SHORT).show(); }
                })
                .setNegativeButton("关闭", null).show();
    }
    private ShareLink() {}
}
