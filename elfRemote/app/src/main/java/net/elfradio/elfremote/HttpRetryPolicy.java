package net.elfradio.elfremote;

import java.io.IOException;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;

/** 各接口分别退避；等待期间不发网络请求，不清除身份或已排队报告。 */
final class HttpRetryPolicy {
    private static final long MAX_DELAY=15*60_000L;
    private final Map<String,Entry> entries=new LinkedHashMap<>();
    private static final class Entry {int failures;long next;}
    static final class StatusFailure extends IOException {
        final int status;final String retryAfter;
        StatusFailure(int status,String retryAfter){super("HTTP "+status);this.status=status;this.retryAfter=retryAfter;}
    }
    private String key(String url)throws Exception {URL u=new URL(url);return u.getProtocol()+"://"+u.getAuthority()+u.getPath();}
    synchronized long remaining(String url,long now)throws Exception {Entry e=entries.get(key(url));return e==null?0:Math.max(0,e.next-now);}
    synchronized void check(String url,long now)throws Exception {
        long delay=remaining(url,now);if(delay>0)throw new IOException("服务器请求退避，剩余毫秒="+delay);
    }
    synchronized void success(String url)throws Exception {entries.remove(key(url));}
    synchronized long failed(String url,Exception error,long now)throws Exception {
        String key=key(url);
        if(error instanceof StatusFailure){int code=((StatusFailure)error).status;if(code<500&&code!=429){entries.remove(key);return 0;}}
        Entry e=entries.get(key);if(e==null){if(entries.size()>=32)entries.remove(entries.keySet().iterator().next());e=new Entry();entries.put(key,e);}
        long delay=Math.min(MAX_DELAY,60_000L<<Math.min(4,e.failures));e.failures=Math.min(5,e.failures+1);
        if(error instanceof StatusFailure){try{long seconds=Long.parseLong(((StatusFailure)error).retryAfter);if(seconds>0)delay=Math.max(delay,Math.min(900,seconds)*1000);}catch(Exception ignored){}}
        e.next=now+delay;return delay;
    }
}
