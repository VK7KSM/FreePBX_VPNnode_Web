package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.IOException;
import java.util.*;

/** 仅修改账号所需字段，其他音频、按键、媒体及厂商配置原样保留。 */
final class SipAccountConfig {
    static JSONObject normalize(JSONObject p)throws Exception {
        String server=p.getString("server"),user=p.getString("username"),password=p.getString("password");
        String auth=p.optString("auth_username",user),transport=p.optString("transport","tls").toLowerCase(Locale.US);
        int port=p.optInt("port","tls".equals(transport)?5061:5060);
        if(!server.matches("[A-Za-z0-9][A-Za-z0-9.-]{0,252}")||!user.matches("[A-Za-z0-9_.+-]{1,128}")
                ||!auth.matches("[A-Za-z0-9_.+@-]{1,128}")||password.isEmpty()||password.length()>256
                ||!password.equals(password.trim())||password.chars().anyMatch(c->c<32||c==127)
                ||!Arrays.asList("tls","tcp","udp").contains(transport)||port<1||port>65535)throw new IOException("SIP账号参数无效");
        return new JSONObject().put("server",server.toLowerCase(Locale.US)).put("username",user).put("auth_username",auth)
                .put("password",password).put("transport",transport).put("port",port);
    }
    static String apply(String original,JSONObject params)throws Exception {
        JSONObject p=normalize(params);
        Map<String,Map<String,String>> ini=read(original),changes=new LinkedHashMap<>();
        String domain=p.getString("server"),user=p.getString("username");
        // 首次启动的default_proxy通常为-1；新增账号不覆盖另一账号。
        int proxy=-1;
        String identity="sip:"+user+"@"+domain;
        for(int i=0;i<100;i++)if(identity.equalsIgnoreCase(value(ini,"proxy_"+i,"reg_identity","").replace("<","").replace(">",""))){proxy=i;break;}
        if(proxy<0){proxy=0;while(ini.containsKey("proxy_"+proxy)&&proxy<100)proxy++;}
        if(proxy>=100)throw new IOException("SIP账号记录数量超限");
        int auth=-1,free=0;
        while(ini.containsKey("auth_info_"+free)&&free<100)free++;
        for(int i=0;i<100;i++) {
            String s="auth_info_"+i;
            if(user.equals(value(ini,s,"username",""))&&domain.equalsIgnoreCase(value(ini,s,"domain",""))){auth=i;break;}
        }
        if(auth<0)auth=free;if(auth>=100)throw new IOException("认证记录数量超限");
        Map<String,String> account=new LinkedHashMap<>();
        account.put("reg_proxy","<sip:"+domain+":"+p.getInt("port")+";transport="+p.getString("transport")+">");
        account.put("reg_route",account.get("reg_proxy"));
        account.put("reg_identity",identity);
        account.put("reg_sendregister","1");account.put("reg_expires","600");
        changes.put("proxy_"+proxy,account);
        Map<String,String> credentials=new LinkedHashMap<>();
        credentials.put("username",user);credentials.put("userid",p.getString("auth_username"));
        credentials.put("passwd",p.getString("password"));credentials.put("ha1","");credentials.put("realm","");credentials.put("domain",domain);
        changes.put("auth_info_"+auth,credentials);
        changes.put("sip",Collections.singletonMap("default_proxy",Integer.toString(proxy)));
        return update(original,changes);
    }
    static Map<String,Map<String,String>> read(String text) {
        Map<String,Map<String,String>> result=new LinkedHashMap<>();String section="";
        for(String line:text.split("\\r?\\n",-1)) {
            String s=line.trim();if(s.startsWith("[")&&s.endsWith("]")){section=s.substring(1,s.length()-1);result.putIfAbsent(section,new LinkedHashMap<>());}
            else if(!s.startsWith("#")&&!s.startsWith(";")&&s.contains("=")) {
                int split=s.indexOf('=');result.computeIfAbsent(section,k->new LinkedHashMap<>()).put(s.substring(0,split).trim(),s.substring(split+1));
            }
        }return result;
    }
    private static String value(Map<String,Map<String,String>> ini,String section,String key,String fallback) {
        return ini.getOrDefault(section,Collections.emptyMap()).getOrDefault(key,fallback);
    }
    static String update(String original,Map<String,Map<String,String>> changes) {
        Map<String,Map<String,String>> left=new LinkedHashMap<>();for(Map.Entry<String,Map<String,String>> e:changes.entrySet())left.put(e.getKey(),new LinkedHashMap<>(e.getValue()));
        StringBuilder out=new StringBuilder();String section="";
        for(String line:original.split("\\r?\\n",-1)) {
            String s=line.trim();
            if(s.startsWith("[")&&s.endsWith("]")) {
                append(out,left.get(section));section=s.substring(1,s.length()-1);out.append(line).append('\n');continue;
            }
            int equals=s.indexOf('=');String key=equals<0?"":s.substring(0,equals).trim();
            if(!s.startsWith("#")&&!s.startsWith(";")&&changes.getOrDefault(section,Collections.emptyMap()).containsKey(key)) {
                Map<String,String> remaining=left.get(section);if(remaining.containsKey(key))out.append(key).append('=').append(remaining.remove(key)).append('\n');
            }else out.append(line).append('\n');
        }
        append(out,left.get(section));
        for(Map.Entry<String,Map<String,String>> e:left.entrySet())if(!e.getValue().isEmpty()){out.append('\n').append('[').append(e.getKey()).append("]\n");append(out,e.getValue());}
        return out.toString();
    }
    private static void append(StringBuilder out,Map<String,String> values){if(values!=null){for(Map.Entry<String,String> e:values.entrySet())out.append(e.getKey()).append('=').append(e.getValue()).append('\n');values.clear();}}
    private SipAccountConfig(){}
}
