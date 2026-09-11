package net.elfradio.elfremote;

import org.json.JSONObject;

/** 清除执行记录：活跃调用不可假取消，中断后自动策略重新核验，手动请求不重放。 */
final class LostWipeAttempt {
    interface Owner { boolean alive(String boot, int pid, String start) throws Exception; }
    static void started(JSONObject s,boolean automatic,String boot,int pid,String start)throws Exception {
        s.put("wipe_state","started").put("wipe_automatic",automatic)
                .put("wipe_owner_boot",boot).put("wipe_owner_pid",pid).put("wipe_owner_start",start);
    }
    static void failed(JSONObject s,long elapsed,String boot)throws Exception {
        int attempts=Math.min(10,s.optInt("wipe_failures")+1);
        s.put("wipe_state","failed").put("wipe_failures",attempts)
                .put("wipe_retry_boot",boot).put("wipe_retry_elapsed",elapsed+Math.min(300000L,30000L << Math.min(4,attempts-1)));
    }
    static void recover(JSONObject s,long elapsed,String boot,Owner owner)throws Exception {
        if(!"started".equals(s.optString("wipe_state")))return;
        // 旧版本没有执行者信息时不能猜测调用已经停止。
        if(!s.has("wipe_owner_pid")||s.optString("wipe_owner_start").isEmpty())return;
        if(!owner.alive(s.optString("wipe_owner_boot"),s.optInt("wipe_owner_pid"),s.optString("wipe_owner_start")))failed(s,elapsed,boot);
    }
    static boolean retry(JSONObject s,long elapsed,String boot)throws Exception {
        if(!"failed".equals(s.optString("wipe_state"))||!s.optBoolean("wipe_automatic")||!s.optBoolean("auto_wipe_enabled"))return false;
        if(!boot.equals(s.optString("wipe_retry_boot"))){
            s.put("wipe_retry_boot",boot).put("wipe_retry_elapsed",elapsed+30000);return false;
        }
        if(elapsed<s.optLong("wipe_retry_elapsed"))return false;
        s.put("wipe_state","idle");s.remove("manual_task");return true;
    }
    static String processStart(String stat) {
        int end=stat.lastIndexOf(')');if(end<0)throw new IllegalArgumentException("lost-process-state-invalid");
        String[] fields=stat.substring(end+1).trim().split("\\s+");
        if(fields.length<20)throw new IllegalArgumentException("lost-process-state-short");
        return fields[19];
    }
    private LostWipeAttempt(){}
}
