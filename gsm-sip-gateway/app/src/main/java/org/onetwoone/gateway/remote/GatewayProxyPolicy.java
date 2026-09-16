package org.onetwoone.gateway.remote;

import java.io.IOException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Fixed local-only proxy boundary. The remote plane cannot widen listeners or enable TUN. */
final class GatewayProxyPolicy {
    static final int HTTP_PORT=17890,SOCKS_PORT=17891;
    static final long MAX_CONFIG_BYTES=2L*1024*1024;

    static void validateConfig(byte[] bytes)throws Exception {
        if(bytes==null||bytes.length<2||bytes.length>MAX_CONFIG_BYTES)throw new IOException("proxy config size invalid");
        String text=new String(bytes,java.nio.charset.StandardCharsets.UTF_8);
        if(text.indexOf('\0')>=0)throw new IOException("proxy config contains NUL");
        Map<String,String> top=new HashMap<>();
        for(String raw:text.split("\\r?\\n",-1)){
            if(raw.isEmpty()||Character.isWhitespace(raw.charAt(0)))continue;
            String line=stripComment(raw).trim();if(line.isEmpty()||line.startsWith("-")||line.startsWith("---"))continue;
            int colon=line.indexOf(':');if(colon<=0)continue;
            String key=unquote(line.substring(0,colon).trim()).toLowerCase(Locale.ROOT);
            String value=line.substring(colon+1).trim();
            if(top.put(key,value)!=null)throw new SecurityException("duplicate proxy key: "+key);
        }
        require(top,"allow-lan","false");
        require(top,"bind-address","127.0.0.1");
        require(top,"port",Integer.toString(HTTP_PORT));
        require(top,"socks-port",Integer.toString(SOCKS_PORT));
        require(top,"mixed-port","0");
        require(top,"redir-port","0");
        require(top,"tproxy-port","0");
        for(String blocked:new String[]{"tun","listeners","inbounds","interface-name","routing-mark","external-controller","external-ui","external-ui-url","dns"})
            if(top.containsKey(blocked))throw new SecurityException("proxy feature forbidden: "+blocked);
    }
    static boolean safeSource(String value){return value!=null&&value.indexOf('\0')<0
            &&value.matches("/data/(?:user/0|data)/org\\.onetwoone\\.gateway/files/proxy-config/[0-9a-f]{64}\\.yaml");}
    private static void require(Map<String,String> values,String key,String expected){
        String actual=unquote(values.get(key));if(!expected.equalsIgnoreCase(actual))throw new SecurityException("unsafe proxy setting: "+key);
    }
    private static String stripComment(String value){boolean single=false,doubled=false;for(int i=0;i<value.length();i++){
        char c=value.charAt(i);if(c=='\''&&!doubled)single=!single;else if(c=='"'&&!single)doubled=!doubled;else if(c=='#'&&!single&&!doubled)return value.substring(0,i);
    }return value;}
    private static String unquote(String value){if(value==null)return "";value=value.trim();if(value.length()>=2&&((value.startsWith("\"")&&value.endsWith("\""))||(value.startsWith("'")&&value.endsWith("'"))))return value.substring(1,value.length()-1).trim();return value;}
    private GatewayProxyPolicy(){}
}
