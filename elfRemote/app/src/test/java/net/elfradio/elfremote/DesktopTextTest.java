package net.elfradio.elfremote;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * 异常消息会显示在设备管理页面上，所以中继地址不能原样带过去，否则会话号会出现在网页上。
 * 令牌不在其中，它在 Authorization 请求头里而不在 URI 里。
 */
public class DesktopTextTest {
    private static final String SESSION = "0123abcd-4567-89ef-0123-456789abcdef";

    @Test public void relayAddressIsRemovedForEveryScheme() {
        for (String scheme : new String[]{"wss", "ws", "https", "http", "file"}) {
            String message = "connect failed " + scheme + "://v.elfradio.net/api/elfremote/desktop/device?session_id=" + SESSION + " after 10s";
            String out = DesktopText.redact(message);
            assertFalse("不能只挡 wss，" + scheme + " 也要挡住：" + out, out.contains(scheme + "://"));
            assertFalse("会话号不得出现在结果里：" + out, out.contains(SESSION));
            assertTrue("地址之后的内容要保留：" + out, out.contains("after 10s"));
        }
    }

    @Test public void whitespaceIsNormalisedBeforeAddressesAreCut() {
        // 换行先归一再切地址，顺序反了会让匹配跨行吃掉后面的正常内容
        String out = DesktopText.redact("failed\nwss://v.elfradio.net/x?session_id=" + SESSION + "\nretrying");
        assertFalse(out.contains(SESSION));
        assertTrue(out.contains("failed"));
        assertTrue(out.contains("retrying"));
        assertFalse(out.contains("\n"));
    }

    @Test public void nullAndBlankAndOverlongAreSafe() {
        assertEquals("", DesktopText.redact(null));
        assertEquals("", DesktopText.redact("   \n\t "));
        String out = DesktopText.redact("x".repeat(500));
        assertEquals(DesktopText.MESSAGE_LIMIT, out.length());
    }

    @Test public void truncationNeverLeavesHalfACharacter() {
        // 正好让第 140 个码元落在代理对中间
        String out = DesktopText.redact("a".repeat(DesktopText.MESSAGE_LIMIT - 1) + "\uD83D\uDE00" + "tail");
        assertTrue("不得以孤立的高位代理项结尾", out.isEmpty() || !Character.isHighSurrogate(out.charAt(out.length() - 1)));
        assertEquals(DesktopText.MESSAGE_LIMIT - 1, out.length());
    }
}
