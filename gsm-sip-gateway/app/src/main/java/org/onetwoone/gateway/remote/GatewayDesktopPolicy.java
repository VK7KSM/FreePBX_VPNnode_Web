package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.net.URI;
import java.security.SecureRandom;
import java.util.Locale;
import org.json.JSONObject;

/** 远程桌面的纯判断：中继地址校验、画质档位、scid 取值。与 Android 无关，便于单测。 */
final class GatewayDesktopPolicy {
    static final long PREPARE_TIMEOUT_MS=30_000L;
    static final long IDLE_LIMIT_MS=20*60*1000L;
    static final int CHUNK=16384;
    static final long BACKPRESSURE_BYTES=2L*1024*1024;
    static final String PATH="/api/elfremote/desktop/device";

    /** 只接受面板同源的 wss 中继地址，且查询串恰好是本次会话号，避免被引到别处。 */
    static URI validate(JSONObject offer,long now)throws Exception {
        String id=offer.getString("session_id"),token=offer.getString("token");
        if(!id.matches("[a-f0-9-]{36}")||!token.matches("[a-f0-9]{64}"))throw new IOException("invalid session identity");
        long expires=offer.getLong("expires_at");
        if(expires<=now||expires>now+PREPARE_TIMEOUT_MS+120_000L)throw new IOException("session expired");
        URI uri=new URI(offer.getString("url")),control=new URI(GatewayRemotePolicy.BASE_URL);
        if(!"wss".equals(uri.getScheme())||!control.getHost().equals(uri.getHost())||uri.getUserInfo()!=null||uri.getFragment()!=null
                ||(uri.getPort()!=-1&&uri.getPort()!=443)||!PATH.equals(uri.getPath())||!("session_id="+id).equals(uri.getRawQuery()))
            throw new IOException("untrusted relay address");
        return uri;
    }

    /** 画质档位：移动网络压到 15 帧 500kbps 960 宽，其余走 30 帧 1.5Mbps 1280 宽。 */
    static JSONObject encoding(String quality)throws Exception {
        boolean cellular="cellular".equals(quality);
        return new JSONObject().put("max_fps",cellular?15:30).put("bit_rate",cellular?500_000:1_500_000).put("max_size",cellular?960:1280);
    }

    /** scid 是 scrcpy 的 8 位十六进制会话号；最高位清零，服务端按有符号 31 位解析。 */
    static String scid(SecureRandom random){
        byte[] bytes=new byte[4];random.nextBytes(bytes);
        return String.format(Locale.ROOT,"%02x%02x%02x%02x",bytes[0]&0x7f,bytes[1]&255,bytes[2]&255,bytes[3]&255);
    }

    static boolean validScid(String value){return value!=null&&value.matches("[0-7][0-9a-f]{7}");}

    /** 核心侧对启动参数收敛到可用区间，防止请求里带来越界取值。 */
    static JSONObject bound(JSONObject request)throws Exception {
        return new JSONObject()
                .put("max_fps",Math.max(1,Math.min(60,request.optInt("max_fps",30))))
                .put("bit_rate",Math.max(100_000,Math.min(8_000_000,request.optInt("bit_rate",1_500_000))))
                .put("max_size",Math.max(0,Math.min(1920,request.optInt("max_size",0))));
    }

    private GatewayDesktopPolicy(){}
}
