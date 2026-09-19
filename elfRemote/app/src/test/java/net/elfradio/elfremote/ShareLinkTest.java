package net.elfradio.elfremote;

import static org.junit.Assert.*;
import net.elfradio.elfremote.qr.QrCode;
import org.json.JSONObject;
import org.junit.Test;
import java.io.File;
import java.io.FileWriter;

public class ShareLinkTest {
    @Test public void requestCarriesIdentityAndRequestId() throws Exception {
        JSONObject r = ShareLink.request("dev_1", "tok", "req-1");
        assertEquals("dev_1", r.getString("device_id"));
        assertEquals("tok", r.getString("token"));
        assertEquals("req-1", r.getString("request_id"));
    }

    @Test public void parseRequiresOkAndUsesUppercaseQrText() throws Exception {
        ShareLink.Result r = ShareLink.parse("{\"ok\":true,\"url\":\"https://v.elfradio.net/m/ABCDEFGHJKLM\",\"expires_at\":123}");
        assertEquals("HTTPS://V.ELFRADIO.NET/M/ABCDEFGHJKLM", r.qrText);
        assertEquals(123, r.expiresAt);
        try { ShareLink.parse("{\"ok\":false,\"msg\":\"设备凭证无效\"}"); fail(); } catch (Exception e) { assertEquals("设备凭证无效", e.getMessage()); }
    }

    /** 全大写网址：字母数字模式，纠错 M，版本 2（25×25）；矩阵写成 PBM 供外部解码器核对。 */
    @Test public void uppercaseUrlFitsVersionTwoAndDumpsMatrix() throws Exception {
        String text = "HTTPS://V.ELFRADIO.NET/M/ABCDEFGHJKLM";
        QrCode qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
        assertEquals(25, qr.size);
        int quiet = 4, n = qr.size + quiet * 2;
        StringBuilder pbm = new StringBuilder("P1\n" + n + " " + n + "\n");
        for (int y = 0; y < n; y++) { for (int x = 0; x < n; x++) pbm.append(qr.getModule(x - quiet, y - quiet) ? "1 " : "0 "); pbm.append('\n'); }
        File out = new File(System.getProperty("java.io.tmpdir"), "elfremote-share-qr.pbm");
        try (FileWriter w = new FileWriter(out)) { w.write(pbm.toString()); }
        assertTrue(out.length() > 0);
    }
}
