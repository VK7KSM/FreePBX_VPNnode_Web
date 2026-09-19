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

    // 2026-09-19 在 Pixel 3 XL 上实测（动态壁纸、屏幕未触碰、每档 10 秒）：
    //   1280/30帧/1.5M 2183 kbps；只把帧率降到 10 仍有 1840；只把码率降到 600k 仍有 1836；
    //   改成 VBR 反而 2313；960/15帧 1402；800/15帧 1189；640/15帧 711；480/10帧 374。
    //   结论：单独压帧率或码率都没用，长边尺寸才是唯一有效的杠杆，码率必须跟着像素走。
    // 上限与面板下发时的夹逼范围对齐（面板夹到 [480,1920]），两边不一致的话
    // 浏览器报了大尺寸会被设备端悄悄压回去，大窗时画面偏软却查不出原因。
    static final int SIZE_FLOOR=320,SIZE_CEILING_WIFI=1920,SIZE_CEILING_CELLULAR=960;
    // 面板还没报尺寸时用的保守默认值，不能直接用上限，否则盲发就按最贵的档走。
    static final int SIZE_DEFAULT_WIFI=1280,SIZE_DEFAULT_CELLULAR=720;
    static final int FPS_WIFI=15,FPS_CELLULAR=10;
    static final int BIT_RATE_FLOOR=300_000,BIT_RATE_CEILING=4_000_000;
    /** 屏幕内容每像素每帧约 0.12 比特，实测在这个量级上画面可读且不浪费。 */
    static final int MILLIBITS_PER_PIXEL_FRAME=120;

    /** 长边取 8 的倍数，编码器对齐要求如此，不对齐会被它自己再截一次。 */
    static int alignedSize(int longEdge,int ceiling){
        int bounded=Math.max(SIZE_FLOOR,Math.min(ceiling,longEdge));
        return bounded-bounded%8;
    }

    static int bitRateFor(long pixels,int fps){
        long value=pixels*fps*MILLIBITS_PER_PIXEL_FRAME/1000L;
        return (int)Math.max(BIT_RATE_FLOOR,Math.min(BIT_RATE_CEILING,value));
    }

    /**
     * 画质档位。浏览器实际显示多大就编多大：超出显示尺寸的像素传过去也会被缩掉，纯浪费；
     * 低于显示尺寸则糊。{@code requestedLongEdge} 是浏览器报来的显示区域长边（设备像素），
     * 为 0 表示它还没报，退回保守默认值。帧率对远程管理来说 15 足够，30 只是多花一倍的帧。
     */
    static JSONObject encoding(String quality,int requestedLongEdge,int displayWidth,int displayHeight)throws Exception {
        boolean cellular="cellular".equals(quality);
        int ceiling=cellular?SIZE_CEILING_CELLULAR:SIZE_CEILING_WIFI;
        int fps=cellular?FPS_CELLULAR:FPS_WIFI;
        int fallback=cellular?SIZE_DEFAULT_CELLULAR:SIZE_DEFAULT_WIFI;
        int longEdge=alignedSize(requestedLongEdge>0?requestedLongEdge:fallback,ceiling);
        int screenLong=Math.max(displayWidth,displayHeight),screenShort=Math.min(displayWidth,displayHeight);
        // 按屏幕纵横比推出短边，才能算准像素数；拿不到屏幕尺寸时按 9:19.5 这类窄屏保守估。
        long shortEdge=screenLong>0?Math.max(1,(long)longEdge*screenShort/screenLong):longEdge/2;
        return new JSONObject().put("max_fps",fps).put("max_size",longEdge)
                .put("bit_rate",bitRateFor((long)longEdge*shortEdge,fps));
    }

    /** scid 是 scrcpy 的 8 位十六进制会话号；最高位清零，服务端按有符号 31 位解析。 */
    static String scid(SecureRandom random){
        byte[] bytes=new byte[4];random.nextBytes(bytes);
        return String.format(Locale.ROOT,"%02x%02x%02x%02x",bytes[0]&0x7f,bytes[1]&255,bytes[2]&255,bytes[3]&255);
    }

    static boolean validScid(String value){return value!=null&&value.matches("[0-7][0-9a-f]{7}");}

    /**
     * 核心侧对启动参数收敛到可用区间，防止请求里带来越界取值。
     * max_size 缺失或为 0 时**不能**原样传给 scrcpy：它把 0 解释成「不限制」，
     * 于是会按整块 1440×2960 编码，像素是 1280 档的四倍，结果和「没指定就省着来」正好相反。
     * 所以这里把缺失与越小值一律抬到安全默认值，而不是留空。
     */
    static final int SIZE_SAFE_DEFAULT=SIZE_DEFAULT_WIFI;
    static JSONObject bound(JSONObject request)throws Exception {
        int requested=request.optInt("max_size",0);
        int size=requested<SIZE_FLOOR?SIZE_SAFE_DEFAULT:Math.min(1920,requested);
        return new JSONObject()
                .put("max_fps",Math.max(1,Math.min(60,request.optInt("max_fps",30))))
                .put("bit_rate",Math.max(100_000,Math.min(8_000_000,request.optInt("bit_rate",1_500_000))))
                .put("max_size",size);
    }

    /**
     * 异常消息要落进设备日志，也会经 fail() 当作 status 发给浏览器显示，所以先洗一遍。
     * 令牌本来就不会出现在里面（它在 Authorization 请求头，不在 URI 里），
     * 但 Java-WebSocket 的异常消息是可能带上中继地址的，那样会话号就会落进日志和网页。
     * 这里把任何 scheme://... 片段整体换掉，并归一换行、限长。
     */
    static final int MESSAGE_LIMIT=140;
    static String redact(String message){
        if(message==null)return "";
        String cleaned=message.replace((char)10,' ').replace((char)13,' ').replace((char)9,' ')
                .replaceAll("[a-zA-Z][a-zA-Z0-9+.-]*://[^ ]*","<地址已隐去>").trim();
        if(cleaned.length()<=MESSAGE_LIMIT)return cleaned;
        // 按 UTF-16 码元截断会把增补平面字符（如 emoji）切成半个孤立代理项，
        // 那样序列化成 JSON 可能不合法。正好切在代理对中间就退一格。
        int end=MESSAGE_LIMIT;
        if(Character.isHighSurrogate(cleaned.charAt(end-1)))end--;
        return cleaned.substring(0,end);
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
