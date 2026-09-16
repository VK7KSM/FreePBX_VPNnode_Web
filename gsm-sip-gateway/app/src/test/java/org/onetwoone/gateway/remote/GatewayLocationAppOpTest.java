package org.onetwoone.gateway.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import java.io.IOException;
import org.junit.Test;

public class GatewayLocationAppOpTest {
    @Test public void parsesUidModeWithoutUsingPackageMode() throws Exception {
        assertEquals("foreground",GatewayLocationAppOp.parseUidMode("Uid mode: FINE_LOCATION: foreground\nFINE_LOCATION: ignore","FINE_LOCATION"));
        assertEquals("allow",GatewayLocationAppOp.parseUidMode("Uid mode: COARSE_LOCATION: allow","COARSE_LOCATION"));
    }
    @Test public void rejectsUnknownMode() {
        assertThrows(IOException.class,()->GatewayLocationAppOp.parseUidMode("COARSE_LOCATION: allow","FINE_LOCATION"));
        assertThrows(IOException.class,()->GatewayLocationAppOp.parseUidMode("FINE_LOCATION: allow","CAMERA"));
    }
}
