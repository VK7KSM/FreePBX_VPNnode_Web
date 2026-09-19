package net.elfradio.elfremote;
import org.json.*;
final class PhotoPolicy {
    static final int MAX_BYTES=256*1024;
    static final long INTERVAL_MS=15*60*1000L;
    static boolean due(long now,long previous){return previous<=0||now<previous||now-previous>=INTERVAL_MS;}
    static long sampledAt(JSONObject report){return Protocol.parseIsoMillis(report.optString("reported_at"));}
    static boolean recent(long now,long sampled){return sampled>0&&now-sampled<=INTERVAL_MS&&sampled<=now+60000L;}
    static boolean critical(JSONObject report){
        JSONObject e=report.optJSONObject("report_event");if(e==null||!"low_battery".equals(e.optString("type"))||e.optInt("level",100)>=2)return false;
        JSONArray thresholds=e.optJSONArray("thresholds");if(thresholds!=null)for(int i=0;i<thresholds.length();i++)if(thresholds.optInt(i)==2)return true;
        return false;
    }
    static boolean wanted(JSONObject report){return "wifi".equals(report.optString("network"))||critical(report);}
    static boolean networkAllowed(boolean wifi,boolean connected,boolean critical){return connected&&(wifi||critical);}
    private PhotoPolicy(){}
}
