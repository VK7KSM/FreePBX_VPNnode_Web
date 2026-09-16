package org.onetwoone.gateway.remote;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.PersistableBundle;
import android.provider.BaseColumns;
import android.provider.Telephony;
import android.telephony.CarrierConfigManager;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import org.json.JSONObject;

/** Collects a bounded, read-only view of mobile-network capability as root. */
final class GatewayMobileStatusCollector {
    static JSONObject collect(Context context) throws Exception {
        TelephonyManager base=(TelephonyManager)context.getSystemService(Context.TELEPHONY_SERVICE);
        SubscriptionManager subscriptions=(SubscriptionManager)context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
        if(base==null||subscriptions==null)throw new IllegalStateException("telephony unavailable");

        int activeCount=Math.max(0,subscriptions.getActiveSubscriptionInfoCount());
        boolean simReady=false;
        int phones=Math.max(1,base.getPhoneCount());
        for(int slot=0;slot<phones;slot++)if(base.getSimState(slot)==TelephonyManager.SIM_STATE_READY){simReady=true;break;}

        int defaultData=SubscriptionManager.getDefaultDataSubscriptionId();
        boolean validDefault=SubscriptionManager.isValidSubscriptionId(defaultData);
        boolean switchReadable=false;
        Boolean dataEnabled=null;
        String networkType="unknown";
        boolean carrierConfigReadable=false;
        if(validDefault){
            TelephonyManager phone=base.createForSubscriptionId(defaultData);
            try {dataEnabled=readDataEnabled(phone);switchReadable=true;}catch(Exception unavailable){}
            try {networkType=networkType(phone.getDataNetworkType());}catch(Exception unavailable){}
            CarrierConfigManager carrier=(CarrierConfigManager)context.getSystemService(Context.CARRIER_CONFIG_SERVICE);
            if(carrier!=null)try{
                PersistableBundle config=carrier.getConfigForSubId(defaultData);
                carrierConfigReadable=config!=null;
            }catch(Exception unavailable){}
        }

        JSONObject result=new JSONObject().put("available",true)
                .put("active_subscription_count",Math.min(activeCount,8))
                .put("sim_ready",simReady).put("default_data_subscription_valid",validDefault)
                .put("data_switch_readable",switchReadable)
                .put("mobile_data_enabled",switchReadable?dataEnabled:JSONObject.NULL)
                .put("current_data_network_type",networkType)
                .put("carrier_config_readable",carrierConfigReadable)
                .put("apn_provider_readable",apnProviderReadable(context));
        return GatewayMobileStatus.sanitize(result);
    }

    static boolean readDataEnabled(Object phone) throws Exception {
        if(phone==null)throw new IllegalStateException("telephony unavailable");
        for(String name:new String[]{"isDataEnabled","getDataEnabled"}){
            Method method;
            try{method=phone.getClass().getMethod(name);}catch(NoSuchMethodException absent){continue;}
            try{
                Object value=method.invoke(phone);
                if(!(value instanceof Boolean))throw new IllegalStateException("invalid data state");
                return (Boolean)value;
            }catch(InvocationTargetException failure){
                Throwable cause=failure.getCause();
                if(cause instanceof Exception)throw (Exception)cause;
                throw failure;
            }
        }
        throw new NoSuchMethodException("data state unavailable");
    }

    private static boolean apnProviderReadable(Context context) {
        Uri uri=Telephony.Carriers.CONTENT_URI;
        try(Cursor cursor=context.getContentResolver().query(uri,new String[]{BaseColumns._ID},null,null,null)){
            return cursor!=null;
        }catch(Exception unavailable){return false;}
    }

    static String networkType(int type) {
        switch(type){
            case TelephonyManager.NETWORK_TYPE_GPRS:return "gprs";
            case TelephonyManager.NETWORK_TYPE_EDGE:return "edge";
            case TelephonyManager.NETWORK_TYPE_UMTS:return "umts";
            case TelephonyManager.NETWORK_TYPE_HSDPA:return "hsdpa";
            case TelephonyManager.NETWORK_TYPE_HSUPA:return "hsupa";
            case TelephonyManager.NETWORK_TYPE_HSPA:return "hspa";
            case TelephonyManager.NETWORK_TYPE_CDMA:return "cdma";
            case TelephonyManager.NETWORK_TYPE_1xRTT:return "1xrtt";
            case TelephonyManager.NETWORK_TYPE_EVDO_0:return "evdo_0";
            case TelephonyManager.NETWORK_TYPE_EVDO_A:return "evdo_a";
            case TelephonyManager.NETWORK_TYPE_EVDO_B:return "evdo_b";
            case TelephonyManager.NETWORK_TYPE_EHRPD:return "ehrpd";
            case TelephonyManager.NETWORK_TYPE_IDEN:return "iden";
            case TelephonyManager.NETWORK_TYPE_HSPAP:return "hspap";
            case TelephonyManager.NETWORK_TYPE_LTE:return "lte";
            case TelephonyManager.NETWORK_TYPE_TD_SCDMA:return "td_scdma";
            case TelephonyManager.NETWORK_TYPE_IWLAN:return "iwlan";
            case TelephonyManager.NETWORK_TYPE_NR:return "nr";
            default:return "unknown";
        }
    }

    private GatewayMobileStatusCollector() {}
}
