package org.onetwoone.gateway.remote;

import java.security.SecureRandom;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayDesktopPolicyTest {
    // 会话号与令牌一律照抄服务端 desktop-relay.js:34 的真实产物，不再手搓一个「看起来像」的常量：
    // crypto.randomUUID() 和 crypto.randomUUID()+crypto.randomUUID()，后者 72 字符、带 8 个短横。
    private static final String ID=UUID.randomUUID().toString();
    private static final String TOKEN=UUID.randomUUID().toString()+UUID.randomUUID();
    private static final long NOW=1_700_000_000_000L;

    private static JSONObject offer(String url) throws Exception {
        return new JSONObject().put("session_id",ID).put("token",TOKEN).put("expires_at",NOW+30_000L).put("url",url);
    }
    private static String good(){return "wss://v.elfradio.net/api/elfremote/desktop/device?session_id="+ID;}

    @Test public void validateAcceptsPanelRelayAddress() throws Exception {
        assertEquals("v.elfradio.net",GatewayDesktopPolicy.validate(offer(good()),NOW).getHost());
        assertEquals("v.elfradio.net",GatewayDesktopPolicy.validate(offer("wss://v.elfradio.net:443/api/elfremote/desktop/device?session_id="+ID),NOW).getHost());
    }

    @Test public void validateRejectsUntrustedOrExpiredOffers() throws Exception {
        String[] addresses={
                "ws://v.elfradio.net/api/elfremote/desktop/device?session_id="+ID,            // 明文
                "wss://evil.example/api/elfremote/desktop/device?session_id="+ID,             // 换了主机
                "wss://v.elfradio.net:8443/api/elfremote/desktop/device?session_id="+ID,      // 换了端口
                "wss://v.elfradio.net/api/elfremote/adb/device?session_id="+ID,               // 换了路径
                "wss://v.elfradio.net/api/elfremote/desktop/device?session_id=other",         // 会话号对不上
                "wss://v.elfradio.net/api/elfremote/desktop/device?session_id="+ID+"&x=1",    // 多带了参数
                "wss://u@v.elfradio.net/api/elfremote/desktop/device?session_id="+ID,         // 带了用户信息
                "wss://v.elfradio.net/api/elfremote/desktop/device?session_id="+ID+"#f"};     // 带了片段
        for(String address:addresses)
            try{GatewayDesktopPolicy.validate(offer(address),NOW);fail("应拒绝 "+address);}catch(Exception expected){}
        try{GatewayDesktopPolicy.validate(offer(good()).put("expires_at",NOW),NOW);fail("应拒绝已过期");}catch(Exception expected){}
        try{GatewayDesktopPolicy.validate(offer(good()).put("expires_at",NOW+3_600_000L),NOW);fail("应拒绝过长有效期");}catch(Exception expected){}
        try{GatewayDesktopPolicy.validate(offer(good()).put("session_id","短"),NOW);fail("应拒绝会话号格式");}catch(Exception expected){}
        try{GatewayDesktopPolicy.validate(offer(good()).put("token","XYZ"),NOW);fail("应拒绝过短令牌");}catch(Exception expected){}
    }

    /**
     * 服务端 desktop-relay.js:34 签发的令牌是两个 UUID 拼接，72 字符、带短横。
     * 曾经这里写死成 64 位纯十六进制（那是 ADB 中继 adb-relay.js:16 的格式），
     * 结果每个 offer 都在第一步就被拒，面板上点远程桌面只会一直转圈。
     */
    @Test public void validateAcceptsTheTokenShapeTheServerActuallyIssues() throws Exception {
        String real=UUID.randomUUID().toString()+UUID.randomUUID();
        assertEquals(72,real.length());
        assertFalse("这正是当初写错的那条正则",real.matches("[a-f0-9]{64}"));
        assertEquals("v.elfradio.net",GatewayDesktopPolicy.validate(offer(good()).put("token",real),NOW).getHost());
    }

    /** 令牌会原样放进 Authorization 头，所以换行、控制字符和空格必须挡住。 */
    @Test public void validateRejectsHeaderUnsafeTokens() throws Exception {
        String base=UUID.randomUUID().toString()+UUID.randomUUID();
        String[] bad={"","short",base+"\r\nX-Injected: 1",base+"\n",base+" extra",base+((char)0),
                base+base+base+base};   // 最后一条超过 256 字符
        for(String value:bad)
            try{GatewayDesktopPolicy.validate(offer(good()).put("token",value),NOW);fail("应拒绝长度 "+value.length()+" 的令牌");}
            catch(Exception expected){}
    }

    /**
     * 画质档位。2026-09-19 在 Pixel 3 XL 上实测（动态壁纸、屏幕未触碰、每档 10 秒）：
     * 1280/30帧/1.5M 得 2183 kbps，单独把帧率压到 10 仍有 1840、单独把码率压到 600k 仍有 1836、
     * 改 VBR 反而 2313；而降长边立竿见影，960 得 1402、800 得 1189、640 得 711、480 得 374。
     * 所以码率必须跟着像素走，固定值没有意义。
     */
    @Test public void encodingFollowsTheBrowserDisplaySize() throws Exception {
        int w=1440,h=2960;
        JSONObject small=GatewayDesktopPolicy.encoding("wifi",480,w,h);
        JSONObject large=GatewayDesktopPolicy.encoding("wifi",1280,w,h);
        assertEquals(480,small.getInt("max_size"));
        assertEquals(1280,large.getInt("max_size"));
        // 显示区域大一倍多，码率跟着涨；小窗时不该按大窗的码率传。
        assertTrue("码率必须随像素增长",large.getInt("bit_rate")>small.getInt("bit_rate")*3);
        assertEquals(GatewayDesktopPolicy.FPS_WIFI,large.getInt("max_fps"));
    }

    @Test public void encodingClampsAndAlignsRequestedSize() throws Exception {
        int w=1440,h=2960;
        // 超出上限要压回上限，低于下限要抬到下限。
        assertEquals(GatewayDesktopPolicy.SIZE_CEILING_WIFI,GatewayDesktopPolicy.encoding("wifi",9999,w,h).getInt("max_size"));
        assertEquals(GatewayDesktopPolicy.SIZE_FLOOR,GatewayDesktopPolicy.encoding("wifi",10,w,h).getInt("max_size"));
        // 编码器要求长边是 8 的倍数。
        for(int requested=321;requested<=1290;requested+=7)
            assertEquals(0,GatewayDesktopPolicy.encoding("wifi",requested,w,h).getInt("max_size")%8);
        // 没报尺寸时退回各档上限，不至于糊。
        assertEquals(GatewayDesktopPolicy.SIZE_CEILING_WIFI,GatewayDesktopPolicy.encoding("wifi",0,w,h).getInt("max_size"));
        assertEquals(GatewayDesktopPolicy.SIZE_CEILING_CELLULAR,GatewayDesktopPolicy.encoding("cellular",0,w,h).getInt("max_size"));
    }

    @Test public void encodingKeepsCellularCheaperThanWifi() throws Exception {
        int w=1440,h=2960;
        JSONObject wifi=GatewayDesktopPolicy.encoding("wifi",0,w,h),cellular=GatewayDesktopPolicy.encoding("cellular",0,w,h);
        assertTrue(cellular.getInt("max_size")<wifi.getInt("max_size"));
        assertTrue(cellular.getInt("max_fps")<wifi.getInt("max_fps"));
        assertTrue(cellular.getInt("bit_rate")<wifi.getInt("bit_rate"));
        // 未知档位按 WiFi 处理，不至于把画质压到最低。
        assertEquals(wifi.getInt("max_fps"),GatewayDesktopPolicy.encoding("ethernet",0,w,h).getInt("max_fps"));
    }

    @Test public void bitRateStaysWithinBounds() throws Exception {
        assertEquals(GatewayDesktopPolicy.BIT_RATE_FLOOR,GatewayDesktopPolicy.bitRateFor(1,1));
        assertEquals(GatewayDesktopPolicy.BIT_RATE_CEILING,GatewayDesktopPolicy.bitRateFor(50_000_000L,60));
        // 拿不到屏幕尺寸也不能算出 0 或负数。
        JSONObject blind=GatewayDesktopPolicy.encoding("wifi",640,0,0);
        assertTrue(blind.getInt("bit_rate")>=GatewayDesktopPolicy.BIT_RATE_FLOOR);
        assertEquals(640,blind.getInt("max_size"));
    }

    @Test public void scidIsEightHexDigitsWithClearedTopBit() {
        SecureRandom random=new SecureRandom();
        for(int i=0;i<500;i++){
            String scid=GatewayDesktopPolicy.scid(random);
            assertEquals(8,scid.length());
            assertTrue(scid,GatewayDesktopPolicy.validScid(scid));
            // scrcpy 按有符号 31 位解析 scid，最高位必须是 0。
            assertTrue(scid,Long.parseLong(scid,16)<0x80000000L);
        }
    }

    @Test public void validScidRejectsAnythingElse() {
        for(String bad:new String[]{null,"","1234567","123456789","0123456G","8abcdef0","FFFFFFF0","0123 567"})
            assertFalse(String.valueOf(bad),GatewayDesktopPolicy.validScid(bad));
    }

    @Test public void boundClampsEncodingRequests() throws Exception {
        JSONObject low=GatewayDesktopPolicy.bound(new JSONObject().put("max_fps",0).put("bit_rate",1).put("max_size",-5));
        assertEquals(1,low.getInt("max_fps")); assertEquals(100_000,low.getInt("bit_rate")); assertEquals(0,low.getInt("max_size"));
        JSONObject high=GatewayDesktopPolicy.bound(new JSONObject().put("max_fps",9999).put("bit_rate",99_000_000).put("max_size",4096));
        assertEquals(60,high.getInt("max_fps")); assertEquals(8_000_000,high.getInt("bit_rate")); assertEquals(1920,high.getInt("max_size"));
        JSONObject missing=GatewayDesktopPolicy.bound(new JSONObject());
        assertEquals(30,missing.getInt("max_fps")); assertEquals(1_500_000,missing.getInt("bit_rate")); assertEquals(0,missing.getInt("max_size"));
    }

    /**
     * 2026-09-19 生产故障的回归测试。
     * 现象：面板点远程桌面，转一会儿断开，日志里 DESKTOP_FAILED 出现在 DESKTOP_CONNECTED 之前。
     * 真因：连接走「先代理后直连」，代理那次必然先回调一次 onError，
     * 当时就把会话判死，随后直连成功的 onOpen 成了空响，scrcpy 从没被拉起来。
     */
    /**
     * 异常消息既落日志又经中继显示在网页上，不能把中继地址带出去，否则会话号就泄进这两处。
     * 原先注释承诺了剥离、代码没做，2026-09-19 按 web-dev 评审改成代码兑现承诺。
     */
    @Test public void redactStripsRelayAddressesAndNormalises() {
        String withUri="Invalid handshake for wss://v.elfradio.net/api/elfremote/desktop/device?session_id="+ID;
        String cleaned=GatewayDesktopPolicy.redact(withUri);
        assertFalse(cleaned,cleaned.contains(ID));
        assertFalse(cleaned,cleaned.contains("v.elfradio.net"));
        assertTrue(cleaned,cleaned.contains("<地址已隐去>"));
        // http、ws、任意 scheme 都要挡住，不能只挡 wss。
        for(String scheme:new String[]{"http","https","ws","wss","file"})
            assertFalse(GatewayDesktopPolicy.redact("x "+scheme+"://v.elfradio.net/a?b="+ID).contains(ID));
        // 换行、回车、制表都归一成空格，免得一条日志被拆成多行。
        String multi=GatewayDesktopPolicy.redact("a"+((char)10)+"b"+((char)13)+"c"+((char)9)+"d");
        assertEquals("a b c d",multi);
        assertEquals("",GatewayDesktopPolicy.redact(null));
        assertEquals("",GatewayDesktopPolicy.redact("   "));
        // 限长，中继对 message 的上限是 140。
        StringBuilder longer=new StringBuilder();
        for(int i=0;i<400;i++)longer.append('x');
        assertEquals(GatewayDesktopPolicy.MESSAGE_LIMIT,GatewayDesktopPolicy.redact(longer.toString()).length());
    }

    /** 截断不能把增补平面字符切成半个孤立代理项，否则序列化成 JSON 可能不合法。 */
    @Test public void redactNeverLeavesALoneSurrogate() throws Exception {
        String emoji=new String(Character.toChars(0x1F600));   // 一个增补平面字符占两个码元
        for(int prefix=0;prefix<8;prefix++){
            StringBuilder text=new StringBuilder();
            for(int i=0;i<GatewayDesktopPolicy.MESSAGE_LIMIT-prefix;i++)text.append('x');
            for(int i=0;i<20;i++)text.append(emoji);
            String cleaned=GatewayDesktopPolicy.redact(text.toString());
            assertTrue("超长应被截断",cleaned.length()<=GatewayDesktopPolicy.MESSAGE_LIMIT);
            assertFalse("末尾不能留半个代理对",cleaned.length()>0&&Character.isHighSurrogate(cleaned.charAt(cleaned.length()-1)));
            // 能原样转成 JSON 再读回来，说明没有非法码元。
            assertEquals(cleaned,new JSONObject().put("m",cleaned).getString("m"));
        }
    }

    @Test public void connectPhaseErrorsMustNotKillTheSession() {
        // 建连中（还没 open）：代理那次的失败与关闭都要忽略，留给直连兜底。
        assertFalse("建连阶段的 onError 不该判死会话",GatewayDesktopPolicy.failOnError(false,true));
        assertFalse("建连阶段的 onClose 不该判死会话",GatewayDesktopPolicy.failOnClose(false,true));
        // 已经连上之后出错，那是真的断了，要收。
        assertTrue(GatewayDesktopPolicy.failOnError(true,true));
        assertTrue(GatewayDesktopPolicy.failOnClose(true,true));
        assertTrue(GatewayDesktopPolicy.failOnError(true,false));
        // 既没在建连也没连上：兜底尝试已经跑完仍然失败，要收，否则会话会一直挂着。
        assertTrue(GatewayDesktopPolicy.failOnError(false,false));
        assertTrue(GatewayDesktopPolicy.failOnClose(false,false));
    }

    /**
     * Android 的 libcore 里 new Socket(Proxy) 只认 SOCKS 与 NO_PROXY，
     * 给 HTTP 型会抛 IllegalArgumentException: Invalid Proxy（Pixel 3 XL / Android 12 实测）。
     * 桌面 JDK 有 HTTP 分支不抛，所以这个坑只能靠这条断言守住。
     */
    @Test public void websocketProxyMustBeSocksBecauseAndroidSocketRejectsHttp() {
        java.net.Proxy route=GatewayProxyWebSocket.websocketProxy();
        assertEquals(java.net.Proxy.Type.SOCKS,route.type());
        assertNotEquals(java.net.Proxy.Type.HTTP,route.type());
    }

    @Test public void safeSourceAcceptsOnlyTheStagedAssetPath() {
        assertTrue(GatewayScrcpyAsset.safeSource("/data/data/org.onetwoone.gateway/files/desktop-core/scrcpy-server-3.3.3"));
        assertTrue(GatewayScrcpyAsset.safeSource("/data/user/0/org.onetwoone.gateway/files/desktop-core/scrcpy-server-3.3.3"));
        for(String bad:new String[]{null,"","/data/local/tmp/scrcpy-server",
                "/data/data/org.onetwoone.gateway/files/desktop-core/scrcpy-server-3.3.4",
                "/data/data/other.app/files/desktop-core/scrcpy-server-3.3.3",
                "/data/data/org.onetwoone.gateway/files/desktop-core/scrcpy-server-3.3.3"+((char)0)+"/x",
                "/data/data/org.onetwoone.gateway/files/desktop-core/../../scrcpy-server-3.3.3"})
            assertFalse(String.valueOf(bad),GatewayScrcpyAsset.safeSource(bad));
    }
}
