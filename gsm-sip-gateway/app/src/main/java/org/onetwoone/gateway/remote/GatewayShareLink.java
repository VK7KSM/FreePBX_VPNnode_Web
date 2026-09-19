package org.onetwoone.gateway.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONObject;
import org.onetwoone.gateway.qr.QrCode;

/**
 * 设备自助生成本机管理链接：向服务器申请短链接，本地生成二维码显示。
 * 链接只含网址不含密码；服务器返回的短码字母表已去掉易混的 0、O、1、I。
 */
final class GatewayShareLink {
    static final String PATH = "/api/devices/share-link";

    /** 请求体：设备身份加一个请求编号，供重试去重。 */
    static JSONObject request(String deviceId, String token, String requestId) throws Exception {
        if (deviceId == null || deviceId.isEmpty()) throw new IllegalArgumentException("device-id-missing");
        if (token == null || token.isEmpty()) throw new IllegalArgumentException("token-missing");
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,96}")) throw new IllegalArgumentException("request-id-invalid");
        return new JSONObject().put("device_id", deviceId).put("token", token).put("request_id", requestId);
    }

    static final class Result {
        final String url, qrText;
        final long expiresAt;
        Result(String url, String qrText, long expiresAt) { this.url = url; this.qrText = qrText; this.expiresAt = expiresAt; }
    }

    /** 解析服务器回复；二维码文本缺省用全大写网址，便于走字母数字模式。 */
    static Result parse(JSONObject reply) throws Exception {
        if (reply == null || !reply.optBoolean("ok")) throw new Exception(reply == null ? "share-link-failed" : reply.optString("msg", "share-link-failed"));
        String url = reply.optString("url", "");
        if (!url.startsWith("https://")) throw new Exception("share-link-url-invalid");
        String qrText = reply.optString("qr_text", "");
        if (qrText.isEmpty()) qrText = url.toUpperCase(Locale.ROOT);
        return new Result(url, qrText, reply.optLong("expires_at", 0));
    }

    /** 剩余有效期的中文提示；不足一分钟显示「即将过期」。 */
    static String remaining(long expiresAt, long now) {
        long left = expiresAt - now;
        if (expiresAt <= 0) return "";
        if (left < 60000L) return "即将过期";
        long hours = left / 3600000L, minutes = left % 3600000L / 60000L;
        return hours > 0 ? "剩余 " + hours + " 小时 " + minutes + " 分钟" : "剩余 " + minutes + " 分钟";
    }

    /** 纠错等级 M；外围留 2 格静区，按可用像素等比放大每个模块。 */
    static Bitmap qrBitmap(String text, int sizePx) {
        QrCode qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
        int quiet = 2, modules = qr.size + quiet * 2, cell = Math.max(1, sizePx / modules), px = modules * cell;
        Bitmap bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.RGB_565);
        int[] row = new int[px];
        for (int y = 0; y < px; y++) {
            int my = y / cell - quiet;
            for (int x = 0; x < px; x++) { int mx = x / cell - quiet; row[x] = qr.getModule(mx, my) ? Color.BLACK : Color.WHITE; }
            bitmap.setPixels(row, 0, px, 0, y, px, 1);
        }
        return bitmap;
    }

    static void generate(Activity activity, GatewayRemoteStore store) {
        if (!store.prefs.getBoolean("paired", false)) { Toast.makeText(activity, "尚未配对", Toast.LENGTH_SHORT).show(); return; }
        Toast.makeText(activity, "正在生成管理链接…", Toast.LENGTH_SHORT).show();
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            try {
                JSONObject body = request(store.deviceId(), store.token(), UUID.randomUUID().toString());
                Result result = parse(GatewayRemoteHttp.request(PATH, body));
                main.post(() -> show(activity, result));
            } catch (Exception error) {
                String detail = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                main.post(() -> Toast.makeText(activity, "生成失败：" + detail, Toast.LENGTH_LONG).show());
            }
        }, "gateway-share-link").start();
    }

    private static void show(Activity activity, Result result) {
        if (activity.isFinishing()) return;
        float density = activity.getResources().getDisplayMetrics().density;
        int screen = Math.min(activity.getResources().getDisplayMetrics().widthPixels, activity.getResources().getDisplayMetrics().heightPixels);
        int qrPx = Math.max(120, Math.min(screen - (int) (48 * density), 400));
        int pad = (int) (8 * density);
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL); box.setPadding(pad, pad, pad, pad); box.setBackgroundColor(Color.WHITE);
        ImageView image = new ImageView(activity);
        image.setImageBitmap(qrBitmap(result.qrText, qrPx)); image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(qrPx, qrPx);
        params.gravity = Gravity.CENTER_HORIZONTAL; image.setLayoutParams(params); box.addView(image);
        TextView text = new TextView(activity);
        text.setText(result.url); text.setTextColor(Color.BLACK); text.setTextSize(11); text.setPadding(0, pad, 0, 0); text.setTextIsSelectable(true);
        box.addView(text);
        TextView hint = new TextView(activity);
        hint.setTextColor(Color.DKGRAY); hint.setTextSize(10);
        String left = remaining(result.expiresAt, System.currentTimeMillis());
        hint.setText(left.isEmpty() ? "免密" : "免密，" + left + "，可在网页设置里改密码与有效期");
        box.addView(hint);
        new AlertDialog.Builder(activity).setTitle("管理链接").setView(box)
                .setPositiveButton("复制链接", (dialog, which) -> {
                    ClipboardManager clip = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clip != null) {
                        clip.setPrimaryClip(ClipData.newPlainText("elfRemote 管理链接", result.url));
                        Toast.makeText(activity, "已复制", Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton("关闭", null).show();
    }

    private GatewayShareLink() {}
}
