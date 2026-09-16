package org.onetwoone.gateway;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class RootHelperTest {
    @Test
    public void buildsOnlySelectedPcmNodePaths() {
        assertEquals("/dev/snd/pcmC0D7c", RootHelper.getAlsaPcmNodePath(0, 7, true));
        assertEquals("/dev/snd/pcmC1D12p", RootHelper.getAlsaPcmNodePath(1, 12, false));
    }
}
