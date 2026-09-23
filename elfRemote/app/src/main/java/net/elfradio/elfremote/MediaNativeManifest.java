package net.elfradio.elfremote;

import android.content.Context;
import org.json.JSONObject;

/**
 * 向服务端要一份「这个原生库去哪儿下」的应答。
 *
 * 完整性不靠这条应答来保证：精简包里的 assets/media-native.json 写死了期望的长度与 SHA-256，
 * 而那个文件在 APK 签名覆盖范围内，改不了。下载完成后按那份期望校验字节，
 * 所以即便服务端被攻破、给回来一个别的库，设备也只会把它丢掉。
 *
 * 这里对服务端应答做的检查因此都是「省一次 12 MB 的白下载」性质的早退：
 * 哈希对不上就根本不必开始下载。唯一一条有安全意义的是主机名——
 * 不能让服务端把设备指到任意地址去，那等于凭空多一个外连目标。
 */
final class MediaNativeManifest {
    static final String PATH = "/api/devices/media-native/offer";

    /** 返回 {url,size,sha256}；取不到或与期望不符时返回 null。 */
    static JSONObject fetch(Context context, JSONObject identity) {
        try {
            PairingStore store = new PairingStore(context);
            String device = store.deviceId();
            if (device.isEmpty()) return null;      // 还没配对，无处可问
            JSONObject request = new JSONObject()
                    .put("device_id", device).put("token", store.token())
                    .put("abi", identity.getString("abi"))
                    .put("sha256", identity.getString("sha256"));
            JSONObject response = new JSONObject(HttpJson.post(Protocol.BASE_URL + PATH, request.toString()));
            return accept(response, identity, Protocol.BASE_URL);
        } catch (Exception e) {
            RuntimeLog.error("media_native_offer_failed", new Exception(e));
            return null;
        }
    }

    /** 与网络分开，便于单测覆盖每一种拒绝理由。 */
    static JSONObject accept(JSONObject response, JSONObject identity, String base) {
        try {
            if (response == null || !response.optBoolean("ok", false)) return null;
            if (!identity.getString("sha256").equals(response.optString("sha256"))) return null;
            if (identity.getLong("size") != response.optLong("size", -1)) return null;
            String url = response.optString("url", "");
            java.net.URL parsed = Protocol.requireHttpsUrl(url);
            // 只接受自己控制面那台主机。哈希校验拦得住伪造的库，但拦不住
            // 「服务端指使设备去连某个地址」这件事本身。
            if (!parsed.getHost().equalsIgnoreCase(new java.net.URL(base).getHost())) return null;
            return new JSONObject().put("url", url)
                    .put("size", identity.getLong("size")).put("sha256", identity.getString("sha256"));
        } catch (Exception e) {
            return null;
        }
    }
}
