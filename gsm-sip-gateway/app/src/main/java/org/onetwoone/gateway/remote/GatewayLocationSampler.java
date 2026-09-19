package org.onetwoone.gateway.remote;

import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.SystemClock;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONObject;

/** Periodically obtains an Android location fix without changing location settings. */
final class GatewayLocationSampler {
    static final long SAMPLE_INTERVAL_MS=15*60_000L,MAX_AGE_NS=15*60_000_000_000L,SAMPLE_TIMEOUT_MS=30_000L;
    static final String FUSED_PROVIDER="fused";
    private final Context context;private final Handler worker;private final Runnable changed;private final LocationManager manager;
    private LocationListener listener;private Location gpsFix,networkFix;private boolean sampling,gpsRequested;
    private Runnable requestCompletion;private long requestSinceNanos;private String requestOutcome="not_sampled";
    private final Runnable timeout=this::finish;
    private final Runnable periodic=this::sampleAndReschedule;

    GatewayLocationSampler(Context context,Handler worker,Runnable changed){this.context=context.getApplicationContext();this.worker=worker;this.changed=changed;manager=(LocationManager)context.getSystemService(Context.LOCATION_SERVICE);}
    void begin(){worker.removeCallbacks(periodic);worker.post(periodic);}
    void close(){worker.removeCallbacks(periodic);worker.removeCallbacks(timeout);removeListener();sampling=false;requestOutcome="service_stopped";requestSinceNanos=0;requestCompletion=null;}
    void requestNow(Runnable completion){worker.post(()->{if(requestCompletion!=null){Runnable previous=requestCompletion;requestCompletion=()->{previous.run();completion.run();};return;}
        requestCompletion=completion;requestSinceNanos=SystemClock.elapsedRealtimeNanos();requestOutcome="sampling";
        if(sampling){worker.removeCallbacks(timeout);removeListener();sampling=false;}start();});}
    String requestOutcome(){return requestOutcome;}
    private void start(){
        if(sampling)return;
        if(manager==null){completeRequest("provider_unavailable");return;}
        if(context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)!=android.content.pm.PackageManager.PERMISSION_GRANTED){completeRequest("permission_denied");return;}
        try{
            boolean gps=enabled(LocationManager.GPS_PROVIDER),fused=enabled(FUSED_PROVIDER),network=enabled(LocationManager.NETWORK_PROVIDER);if(!gps&&!fused&&!network){completeRequest("location_disabled");return;}
            gpsRequested=gps;
            sampling=true;listener=new LocationListener(){
                @Override public void onLocationChanged(Location location){if(!sampling||!recent(location,SystemClock.elapsedRealtimeNanos()))return;if(LocationManager.GPS_PROVIDER.equals(location.getProvider())){gpsFix=location;finish("sampled");}else{networkFix=location;if(!gpsRequested)finish("sampled");}}
                @Override public void onStatusChanged(String provider,int status,Bundle extras){}
                @Override public void onProviderEnabled(String provider){}
                @Override public void onProviderDisabled(String provider){}
            };
            if(gps)manager.requestLocationUpdates(LocationManager.GPS_PROVIDER,1000,0,listener,worker.getLooper());
            if(fused)manager.requestLocationUpdates(FUSED_PROVIDER,1000,0,listener,worker.getLooper());
            if(network)manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER,1000,0,listener,worker.getLooper());
            worker.postDelayed(timeout,SAMPLE_TIMEOUT_MS);
        }catch(SecurityException denied){sampling=false;removeListener();completeRequest("permission_denied");}
        catch(Exception unavailable){sampling=false;removeListener();completeRequest("provider_unavailable");}
    }
    private void sampleAndReschedule(){start();worker.postDelayed(periodic,SAMPLE_INTERVAL_MS);}
    private boolean enabled(String provider){return manager.getAllProviders().contains(provider)&&manager.isProviderEnabled(provider);}

    /**
     * 定位可用性，随周期上报一起送，供面板区分「定位被关了」和「还没定到」。
     * 以前这个原因只在面板主动下发定位任务时才回报，平时上报里没有，
     * 面板看不出差别就一律退回 IP 定位显示两公里，每次都得连设备翻 dumpsys 才知道。
     * 只报三个来源的开关与权限状态，不含坐标，也不改任何定位设置。
     */
    JSONObject state(){
        try{
            if(manager==null)return classify(false,false,false,false,false);
            boolean permitted=context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    ==android.content.pm.PackageManager.PERMISSION_GRANTED;
            return classify(true,permitted,enabled(LocationManager.GPS_PROVIDER),
                    enabled(FUSED_PROVIDER),enabled(LocationManager.NETWORK_PROVIDER));
        }catch(Exception unavailable){
            try{return classify(false,false,false,false,false);}catch(Exception ignored){return null;}
        }
    }

    /** 纯分类，便于单测。reason 的优先级：没有服务 &gt; 没有权限 &gt; 总开关关闭 &gt; 可用。 */
    static JSONObject classify(boolean hasService,boolean permitted,boolean gps,boolean fused,boolean network){
        String reason=!hasService?"provider_unavailable":!permitted?"permission_denied"
                :(!gps&&!fused&&!network)?"location_disabled":"ok";
        try{
            return new JSONObject().put("enabled","ok".equals(reason)).put("reason",reason)
                    .put("gps",gps).put("fused",fused).put("network",network);
        }catch(Exception impossible){return null;}
    }
    private void finish(){finish("timeout");}
    private void finish(String outcome){if(!sampling)return;sampling=false;worker.removeCallbacks(timeout);removeListener();
        if(requestCompletion!=null){long now=SystemClock.elapsedRealtimeNanos();boolean fresh=freshForRequest(gpsFix,now,requestSinceNanos)||freshForRequest(networkFix,now,requestSinceNanos);completeRequest(fresh?"sampled":outcome);}changed.run();}
    private void completeRequest(String outcome){requestOutcome=outcome;requestSinceNanos=0;Runnable completion=requestCompletion;requestCompletion=null;if(completion!=null)completion.run();}
    private void removeListener(){if(listener==null||manager==null)return;try{manager.removeUpdates(listener);}catch(Exception ignored){}listener=null;}
    JSONObject best(String networkType){
        if(manager==null)return null;try{
            Location best=null;long now=SystemClock.elapsedRealtimeNanos();
            for(String provider:new String[]{LocationManager.GPS_PROVIDER,FUSED_PROVIDER,LocationManager.NETWORK_PROVIDER}){
                if(!enabled(provider))continue;Location candidate=manager.getLastKnownLocation(provider);
                if(candidate==null||!recent(candidate,now))continue;
                if(best==null||LocationManager.GPS_PROVIDER.equals(provider))best=candidate;
                if(LocationManager.GPS_PROVIDER.equals(provider))break;
            }
            if(gpsFix!=null&&recent(gpsFix,now))best=gpsFix;
            if(best==null&&networkFix!=null&&recent(networkFix,now))best=networkFix;if(best==null)return null;
            JSONObject value=new JSONObject().put("lat",best.getLatitude()).put("lng",best.getLongitude())
                    .put("acc_m",best.hasAccuracy()?Math.round(best.getAccuracy()):JSONObject.NULL).put("at",utc(best.getTime()));
            String bucket=sourceBucket(best.getProvider(),networkType);return new JSONObject().put("bucket",bucket).put("value",value);
        }catch(Exception unavailable){return null;}
    }
    static boolean recent(Location location,long now){long at=location==null?0:location.getElapsedRealtimeNanos();return at>0&&now>=at&&now-at<=MAX_AGE_NS;}
    static boolean freshForRequest(Location location,long now,long since){return recent(location,now)&&since>0&&location.getElapsedRealtimeNanos()>=since;}
    static String sourceBucket(String provider,String networkType){if(LocationManager.GPS_PROVIDER.equals(provider))return "gps";return "wifi".equals(networkType)?"wifi":"cellular".equals(networkType)?"cell":"cell";}
    private static String utc(long time){SimpleDateFormat format=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.US);format.setTimeZone(TimeZone.getTimeZone("UTC"));return format.format(new Date(time));}
}
