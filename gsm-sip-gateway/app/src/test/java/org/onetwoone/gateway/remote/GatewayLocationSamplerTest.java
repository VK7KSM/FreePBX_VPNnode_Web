package org.onetwoone.gateway.remote;

import android.location.Location;
import android.location.LocationManager;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=31)
public class GatewayLocationSamplerTest {
    @Test public void mapsGpsAndNetworkFixesToHonestBuckets(){
        assertEquals("gps",GatewayLocationSampler.sourceBucket(LocationManager.GPS_PROVIDER,"wifi"));
        assertEquals("wifi",GatewayLocationSampler.sourceBucket(LocationManager.NETWORK_PROVIDER,"wifi"));
        assertEquals("cell",GatewayLocationSampler.sourceBucket(LocationManager.NETWORK_PROVIDER,"cellular"));
    }
    @Test public void rejectsFutureAndExpiredFixes(){
        Location location=new Location(LocationManager.GPS_PROVIDER);location.setElapsedRealtimeNanos(1_000_000_000L);
        assertTrue(GatewayLocationSampler.recent(location,1_000_000_000L));
        assertFalse(GatewayLocationSampler.recent(location,1_000_000_000L+GatewayLocationSampler.MAX_AGE_NS+1));
        assertFalse(GatewayLocationSampler.recent(location,999_999_999L));
    }
}
