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

    /**
     * 会话号与令牌只做健壮性检查，不锁形状。
     * 令牌是服务端签发、服务端校验的持有者凭据，设备端验它长什么样拿不到任何安全收益，
     * 只会把自己绑死在服务端的实现细节上：它现在是两个 UUID 拼接（72 字符、带短横），
     * 一旦服务端换成别的长度，写死的正则会让网关静悄悄地再也开不出桌面。
     * 真正要挡的是它会被放进 Authorization 头，所以限字符集与长度，杜绝换行与控制字符注入。
     * 会话号同理，它还要按字面拼进查询串比对，所以只收 URL 未保留字符。
     */
    static final String TOKEN="[A-Za-z0-9._~+/=-]{16,256}";
    static final String SESSION_ID="[A-Za-z0-9._~-]{8,64}";

    /** 只接受面板同源的 wss 中继地址，且查询串恰好是本次会话号，避免被引到别处。 */
    static URI validate(JSONObject offer,long now)throws Exception {
        String id=offer.getString("session_id"),token=offer.getString("token");
        if(!id.matches(SESSION_ID)||!token.matches(TOKEN))throw new IOException("invalid session identity");
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

    /**
     * 建连阶段的错误不能直接判会话失败。
     * {@link GatewayProxyWebSocket} 是「先试代理、失败再直连」，代理那次失败必然先回调一次 onError；
     * 如果那时就把会话置为已关闭，随后直连成功的 onOpen 就成了空响，表现是「连上了却什么都不发生」，
     * 最后被中继按准备超时断开。GatewayAdbSessions 一直有这道闸，本类 2026-09-19 补上。
     */
    static boolean failOnError(boolean opened,boolean connecting){return opened||!connecting;}

    /** 同理：建连阶段的关闭是代理那次尝试的收尾，不是会话结束。 */
    static boolean failOnClose(boolean opened,boolean connecting){return opened||!connecting;}

    private GatewayDesktopPolicy(){}
}
