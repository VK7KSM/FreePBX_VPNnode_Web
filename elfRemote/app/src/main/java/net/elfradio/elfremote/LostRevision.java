package net.elfradio.elfremote;

import org.json.JSONObject;
import java.util.UUID;

/** 退出推进世代，旧启用任务即使丢失应用回执也不能重新生效。 */
final class LostRevision {
    static String current(JSONObject s){return s.optString("revision","initial");}
    static void require(JSONObject s,JSONObject request){
        if(!current(s).equals(request.optString("expected_revision")))throw new IllegalStateException("lost-stale-policy");
    }
    static void advance(JSONObject s)throws Exception{s.put("revision",UUID.randomUUID().toString()).put("revision_seq",Math.addExact(s.optLong("revision_seq"),1));}
    private LostRevision(){}
}
