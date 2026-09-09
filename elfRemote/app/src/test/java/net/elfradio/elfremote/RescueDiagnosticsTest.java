package net.elfradio.elfremote;
import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class RescueDiagnosticsTest {
    @Test public void preserves64BitMemoryAndSkipsInvalidValues()throws Exception{
        JSONObject bytes=RescueDiagnostics.memoryBytes("MemTotal: 8388608 kB\nMemAvailable: 12345 kB\nHugePages_Total: 0\nBad: nope kB\nNegative: -3 kB\nOverflow: 9223372036854775807 kB\n");
        assertEquals(8589934592L,bytes.getLong("MemTotal"));
        assertEquals(12641280L,bytes.getLong("MemAvailable"));
        assertEquals(2,bytes.length());
    }
    @Test public void missingAndroidPropertiesDoNotPreventIndependentDiagnostics()throws Exception{
        JSONObject result=RescueDiagnostics.collect();
        assertTrue(result.getLong("sampled_at_ms")>0);
        assertTrue(result.getJSONObject("properties").isNull("sys.boot_completed"));
        assertTrue(result.getJSONObject("memory").has("source"));
        assertEquals(3,result.getJSONArray("storage").length());
        assertNotNull(result.getJSONArray("interfaces"));
    }
}
