package org.onetwoone.gateway.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import java.io.IOException;
import org.junit.Test;

public class GatewayLocationAppOpTest {
    @Test public void parsesUidModeWithoutUsingPackageMode() throws Exception {
        assertEquals("foreground",GatewayLocationAppOp.parseUidMode("Uid mode: FINE_LOCATION: foreground\nFINE_LOCATION: ignore"));
        assertEquals("allow",GatewayLocationAppOp.parseUidMode("FINE_LOCATION: allow"));
    }
    @Test public void rejectsUnknownMode() {assertThrows(IOException.class,()->GatewayLocationAppOp.parseUidMode("COARSE_LOCATION: allow"));}
}
