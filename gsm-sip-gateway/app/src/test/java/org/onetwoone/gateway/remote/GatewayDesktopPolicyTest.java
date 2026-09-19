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

    @Test public void encodingDropsRatesOnCellular() throws Exception {
        JSONObject wifi=GatewayDesktopPolicy.encoding("wifi"),cellular=GatewayDesktopPolicy.encoding("cellular");
        assertEquals(30,wifi.getInt("max_fps")); assertEquals(1_500_000,wifi.getInt("bit_rate")); assertEquals(1280,wifi.getInt("max_size"));
        assertEquals(15,cellular.getInt("max_fps")); assertEquals(500_000,cellular.getInt("bit_rate")); assertEquals(960,cellular.getInt("max_size"));
        // 未知档位按 WiFi 处理，不至于把画质压到最低。
        assertEquals(30,GatewayDesktopPolicy.encoding("ethernet").getInt("max_fps"));
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
