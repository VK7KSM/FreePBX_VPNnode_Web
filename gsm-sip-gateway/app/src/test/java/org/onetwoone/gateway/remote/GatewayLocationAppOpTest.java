package org.onetwoone.gateway.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import java.io.IOException;
import org.junit.Test;

public class GatewayLocationAppOpTest {
    @Test public void preservesEverySupportedMode() throws Exception {
        assertEquals("allow",GatewayLocationAppOp.modeName(0));
        assertEquals("ignore",GatewayLocationAppOp.modeName(1));
        assertEquals("deny",GatewayLocationAppOp.modeName(2));
        assertEquals("default",GatewayLocationAppOp.modeName(3));
        assertEquals("foreground",GatewayLocationAppOp.modeName(4));
    }
    @Test public void rejectsUnknownMode() {assertThrows(IOException.class,()->GatewayLocationAppOp.modeName(99));}
}
