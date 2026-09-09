package net.elfradio.elfremote;
import org.json.*;
final class PhotoPolicy {
    static final int MAX_BYTES=256*1024;
    static boolean critical(JSONObject report){
        JSONObject e=report.optJSONObject("report_event");if(e==null||!"low_battery".equals(e.optString("type"))||e.optInt("level",100)>=2)return false;
        JSONArray thresholds=e.optJSONArray("thresholds");if(thresholds!=null)for(int i=0;i<thresholds.length();i++)if(thresholds.optInt(i)==2)return true;
        return false;
    }
    static boolean wanted(JSONObject report){return "wifi".equals(report.optString("network"))||critical(report);}
    static boolean networkAllowed(boolean wifi,boolean connected,boolean critical){return connected&&(wifi||critical);}
    private PhotoPolicy(){}
}
