package org.onetwoone.gateway.remote;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class GatewayReportOutboxTest {
    @Test public void resumesOnlyTheCurrentApplicationVersion()throws Exception {
        JSONObject report=new JSONObject().put("report_id","report-1").put("app_version","alpha54");
        assertEquals("report-1",GatewayReportOutbox.resume(report.toString(),"alpha54").getString("report_id"));
        assertNull(GatewayReportOutbox.resume(report.toString(),"alpha36"));
    }
}
