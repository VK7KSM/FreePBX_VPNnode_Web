package net.elfradio.elfremote;

import org.json.JSONObject;

/** 纯计时规则：断联与未配对分别计时，关闭开关永不到期。 */
final class LostTimer {
    static final long HOUR=3600000L;
    static void mark(JSONObject state,String prefix,long wall,long elapsed,String boot)throws Exception {
        state.put(prefix+"_wall",wall).put(prefix+"_elapsed",elapsed).put(prefix+"_boot",boot);
    }
    static long age(JSONObject state,String prefix,long wall,long elapsed,String boot) {
        if(!state.has(prefix+"_wall"))return 0;
        return Math.max(0,boot.equals(state.optString(prefix+"_boot"))
                ?elapsed-state.optLong(prefix+"_elapsed"):wall-state.optLong(prefix+"_wall"));
    }
    static long remaining(JSONObject s,long wall,long elapsed,String boot) {
        if(!s.optBoolean("auto_wipe_enabled")||!s.optString("wipe_state","idle").equals("idle"))return Long.MAX_VALUE;
        long duration=Math.max(1,Math.min(168,s.optInt("timeout_hours",24)))*HOUR;
        long age=age(s,"contact",wall,elapsed,boot);
        if(!s.optBoolean("paired",true))age=Math.max(age,age(s,"unpaired",wall,elapsed,boot));
        return Math.max(0,duration-age);
    }
    static String trigger(JSONObject s,long wall,long elapsed,String boot) {
        return !s.optBoolean("paired",true)&&age(s,"unpaired",wall,elapsed,boot)>=age(s,"contact",wall,elapsed,boot)?"unpaired":"offline";
    }
    static void contact(JSONObject s,Boolean paired,long unpairedAt,long wall,long elapsed,String boot)throws Exception {
        mark(s,"contact",wall,elapsed,boot);
        if(paired!=null){
            boolean previous=s.optBoolean("paired",true);s.put("paired",paired);
            if(!paired&&previous){
                long since=unpairedAt>0?Math.max(s.optLong("armed_wall",wall),Math.min(wall,unpairedAt)):wall;
                mark(s,"unpaired",since,Math.max(0,elapsed-(wall-since)),boot);
            }
            if(paired)for(String key:new String[]{"unpaired_wall","unpaired_elapsed","unpaired_boot"})s.remove(key);
        }
    }
    static void arm(JSONObject s,boolean enabled,int hours,boolean paired,long wall,long elapsed,String boot)throws Exception {
        boolean newlyArmed=enabled&&!s.optBoolean("auto_wipe_enabled");
        s.put("auto_wipe_enabled",enabled).put("timeout_hours",hours).put("wipe_state","idle");
        if(newlyArmed){s.put("armed_wall",wall);mark(s,"contact",wall,elapsed,boot);s.put("paired",paired);if(!paired)mark(s,"unpaired",wall,elapsed,boot);}
        if(!enabled)s.remove("manual_task");
    }
    private LostTimer(){}
}
