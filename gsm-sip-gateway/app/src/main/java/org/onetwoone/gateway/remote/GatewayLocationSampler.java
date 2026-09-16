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
    private LocationListener listener;private Location gpsFix,networkFix;private boolean sampling;
    private final Runnable timeout=this::finish;
    private final Runnable periodic=this::sampleAndReschedule;

    GatewayLocationSampler(Context context,Handler worker,Runnable changed){this.context=context.getApplicationContext();this.worker=worker;this.changed=changed;manager=(LocationManager)context.getSystemService(Context.LOCATION_SERVICE);}
    void begin(){worker.removeCallbacks(periodic);worker.post(periodic);}
    void close(){worker.removeCallbacks(periodic);worker.removeCallbacks(timeout);removeListener();sampling=false;}
    private void start(){
        if(sampling||manager==null||context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)!=android.content.pm.PackageManager.PERMISSION_GRANTED)return;
        try{
            boolean gps=enabled(LocationManager.GPS_PROVIDER),fused=enabled(FUSED_PROVIDER),network=enabled(LocationManager.NETWORK_PROVIDER);if(!gps&&!fused&&!network)return;
            sampling=true;listener=new LocationListener(){
                @Override public void onLocationChanged(Location location){if(!sampling||!recent(location,SystemClock.elapsedRealtimeNanos()))return;if(LocationManager.GPS_PROVIDER.equals(location.getProvider())){gpsFix=location;finish();}else networkFix=location;}
                @Override public void onStatusChanged(String provider,int status,Bundle extras){}
                @Override public void onProviderEnabled(String provider){}
                @Override public void onProviderDisabled(String provider){}
            };
            if(gps)manager.requestLocationUpdates(LocationManager.GPS_PROVIDER,1000,0,listener,worker.getLooper());
            if(fused)manager.requestLocationUpdates(FUSED_PROVIDER,1000,0,listener,worker.getLooper());
            if(network)manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER,1000,0,listener,worker.getLooper());
            worker.postDelayed(timeout,SAMPLE_TIMEOUT_MS);
        }catch(SecurityException denied){sampling=false;removeListener();}
        catch(Exception unavailable){sampling=false;removeListener();}
    }
    private void sampleAndReschedule(){start();worker.postDelayed(periodic,SAMPLE_INTERVAL_MS);}
    private boolean enabled(String provider){return manager.getAllProviders().contains(provider)&&manager.isProviderEnabled(provider);}
    private void finish(){if(!sampling)return;sampling=false;worker.removeCallbacks(timeout);removeListener();changed.run();}
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
    static String sourceBucket(String provider,String networkType){if(LocationManager.GPS_PROVIDER.equals(provider))return "gps";return "wifi".equals(networkType)?"wifi":"cellular".equals(networkType)?"cell":"cell";}
    private static String utc(long time){SimpleDateFormat format=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.US);format.setTimeZone(TimeZone.getTimeZone("UTC"));return format.format(new Date(time));}
}
