package org.onetwoone.gateway.remote;

import android.telephony.TelephonyManager;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=31)
public class GatewayMobileStatusTest {
    @Test public void emitsOnlyApprovedReadOnlyFields() throws Exception {
        JSONObject input=valid().put("subscription_id",7).put("iccid","secret")
                .put("apn_password","secret").put("carrier_name","private").put("write_locked",false);
        JSONObject result=GatewayMobileStatus.sanitize(input);
        assertEquals(11,result.length());assertEquals(1,result.getInt("schema_version"));assertTrue(result.getBoolean("available"));
        assertTrue(result.getBoolean("write_locked"));assertEquals(1,result.getInt("active_subscription_count"));
        for(String forbidden:new String[]{"subscription_id","iccid","apn_password","carrier_name"})assertFalse(result.has(forbidden));
    }

    @Test public void keepsUnavailableDataSwitchExplicit() throws Exception {
        JSONObject input=valid().put("data_switch_readable",false).put("mobile_data_enabled",JSONObject.NULL);
        JSONObject result=GatewayMobileStatus.sanitize(input);
        assertFalse(result.getBoolean("data_switch_readable"));assertTrue(result.isNull("mobile_data_enabled"));
    }

    @Test public void rejectsAmbiguousOrUnboundedValues() throws Exception {
        assertRejected(valid().put("active_subscription_count",9));
        assertRejected(valid().put("active_subscription_count","1"));
        assertRejected(valid().put("sim_ready","true"));
        assertRejected(valid().put("mobile_data_enabled",JSONObject.NULL));
        assertRejected(valid().put("current_data_network_type","5G-private"));
        assertRejected(valid().put("data_switch_readable",false).put("mobile_data_enabled",true));
    }

    @Test public void reportsReadFailureWithoutPretendingThereIsNoSim() throws Exception {
        JSONObject unavailable=GatewayMobileStatus.unavailable();
        assertFalse(unavailable.getBoolean("available"));assertEquals(0,unavailable.getInt("active_subscription_count"));
        assertFalse(unavailable.getBoolean("sim_ready"));assertTrue(unavailable.isNull("mobile_data_enabled"));
        assertEquals(unavailable.toString(),GatewayMobileStatus.stored("private invalid state").toString());
        JSONObject forged=valid().put("available",false).put("iccid","secret").put("sim_ready",true);
        assertEquals(unavailable.toString(),GatewayMobileStatus.sanitize(forged).toString());
    }

    @Test public void readsModernAndLegacyDataSwitchWithoutFalseFallback() throws Exception {
        assertTrue(GatewayMobileStatusCollector.readDataEnabled(new ModernPhone()));
        assertFalse(GatewayMobileStatusCollector.readDataEnabled(new LegacyPhone()));
        try{GatewayMobileStatusCollector.readDataEnabled(new BrokenModernPhone());fail("exception was hidden");}
        catch(SecurityException expected){assertEquals("denied",expected.getMessage());}
    }

    @Test public void mapsNetworkTypesToFixedNonCarrierValues() {
        assertEquals("lte",GatewayMobileStatusCollector.networkType(TelephonyManager.NETWORK_TYPE_LTE));
        assertEquals("iwlan",GatewayMobileStatusCollector.networkType(TelephonyManager.NETWORK_TYPE_IWLAN));
        assertEquals("nr",GatewayMobileStatusCollector.networkType(TelephonyManager.NETWORK_TYPE_NR));
        assertEquals("unknown",GatewayMobileStatusCollector.networkType(9999));
    }

    private static JSONObject valid() throws Exception {
        return new JSONObject().put("available",true).put("active_subscription_count",1).put("sim_ready",true)
                .put("default_data_subscription_valid",true).put("data_switch_readable",true)
                .put("mobile_data_enabled",true).put("current_data_network_type","iwlan")
                .put("carrier_config_readable",true).put("apn_provider_readable",true);
    }
    private static void assertRejected(JSONObject value) throws Exception {
        try{GatewayMobileStatus.sanitize(value);fail("invalid status accepted");}
        catch(IllegalArgumentException expected){}
    }
    public static final class ModernPhone {public boolean isDataEnabled(){return true;}public boolean getDataEnabled(){return false;}}
    public static final class LegacyPhone {public boolean getDataEnabled(){return false;}}
    public static final class BrokenModernPhone {public boolean isDataEnabled(){throw new SecurityException("denied");}public boolean getDataEnabled(){return true;}}
}
