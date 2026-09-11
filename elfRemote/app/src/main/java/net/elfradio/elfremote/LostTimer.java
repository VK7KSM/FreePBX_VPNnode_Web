package net.elfradio.elfremote;

import org.json.JSONObject;

/** 纯计时规则：断联与未配对分别计时，关闭开关永不到期。 */
final class LostTimer {
    static final long HOUR=3600000L;
    static void mark(JSONObject state,String prefix,long wall,long elapsed,String boot)throws Exception {
        state.put(prefix+"_wall",wall).put(prefix+"_elapsed",elapsed).put(prefix+"_boot",boot).put(prefix+"_age",0);
    }
    static long age(JSONObject state,String prefix,long wall,long elapsed,String boot) {
        if(!state.has(prefix+"_wall")||("armed".equals(prefix)&&!state.has("armed_elapsed")))return 0;
        long saved=Math.max(0,state.optLong(prefix+"_age"));
        // 重启后不相信可任意修改的墙上时间；保留已消耗时长，累计本次开机时间。
        long delta=boot.equals(state.optString(prefix+"_boot"))?Math.max(0,elapsed-state.optLong(prefix+"_elapsed")):Math.max(0,elapsed);
        return Math.min(168*HOUR, saved+Math.min(168*HOUR,delta));
    }
    static void checkpoint(JSONObject s,long wall,long elapsed,String boot)throws Exception {
        if(!s.optBoolean("auto_wipe_enabled"))return;
        for(String prefix:new String[]{"contact","unpaired","armed"})if(s.has(prefix+"_wall")){
            long used=age(s,prefix,wall,elapsed,boot);
            if(!boot.equals(s.optString(prefix+"_boot")))s.put("clock_rebased",true);
            s.put(prefix+"_age",used).put(prefix+"_elapsed",elapsed).put(prefix+"_boot",boot);
        }
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
                long known=age(s,"armed",wall,elapsed,boot);
                long used=unpairedAt>0?Math.min(known,Math.max(0,wall-Math.min(wall,unpairedAt))):0;
                mark(s,"unpaired",wall,elapsed,boot);s.put("unpaired_age",used);
            }
            if(paired)for(String key:new String[]{"unpaired_wall","unpaired_elapsed","unpaired_boot"})s.remove(key);
        }
    }
    static void arm(JSONObject s,boolean enabled,int hours,boolean paired,long wall,long elapsed,String boot)throws Exception {
        boolean newlyArmed=enabled&&!s.optBoolean("auto_wipe_enabled");
        s.put("auto_wipe_enabled",enabled).put("timeout_hours",hours).put("wipe_state","idle");
        if(newlyArmed){mark(s,"armed",wall,elapsed,boot);mark(s,"contact",wall,elapsed,boot);s.put("paired",paired);if(!paired)mark(s,"unpaired",wall,elapsed,boot);}
        if(!enabled)s.remove("manual_task");
    }
    private LostTimer(){}
}
