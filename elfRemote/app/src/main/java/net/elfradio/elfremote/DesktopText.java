package net.elfradio.elfremote;

/**
 * 远程桌面状态消息的清洗。
 *
 * 异常消息会经 status 信令发给浏览器，显示在设备管理页面上。Java-WebSocket 的异常消息
 * 可能带上中继地址，那样会话号就会出现在网页上。令牌不会出现在其中，它在 Authorization
 * 请求头里而不在 URI 里。
 *
 * 诊断日志那侧不需要这个：RuntimeLog.error 本来就只写异常类名与调用栈，不写异常消息。
 */
final class DesktopText {
    /** 与中继对 status.message 的截断长度一致。 */
    static final int MESSAGE_LIMIT = 140;

    static String redact(String message) {
        if (message == null) return "";
        // 先把换行、回车、制表归一成空格，再按空格切地址：顺序反了会让匹配跨行吃过头。
        String cleaned = message.replace((char) 10, ' ').replace((char) 13, ' ').replace((char) 9, ' ')
                .replaceAll("[a-zA-Z][a-zA-Z0-9+.-]*://[^ ]*", "<地址已隐去>").trim();
        if (cleaned.length() <= MESSAGE_LIMIT) return cleaned;
        int end = MESSAGE_LIMIT;
        // 避免正好切在代理对中间，留下半个字符会让 JSON 不合法
        if (Character.isHighSurrogate(cleaned.charAt(end - 1))) end--;
        return cleaned.substring(0, end);
    }

    private DesktopText() {}
}
