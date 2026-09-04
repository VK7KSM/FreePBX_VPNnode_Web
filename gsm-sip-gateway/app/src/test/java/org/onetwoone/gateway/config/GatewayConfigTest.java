package org.onetwoone.gateway.config;

import android.app.Application;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import static org.junit.Assert.*;

/**
 * Unit tests for GatewayConfig.
 * Tests configuration storage and retrieval.
 */
@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class GatewayConfigTest {

    private GatewayConfig config;

    @Before
    public void setUp() {
        Application app = RuntimeEnvironment.getApplication();
        // Reset singleton for clean tests
        try {
            java.lang.reflect.Field instance = GatewayConfig.class.getDeclaredField("instance");
            instance.setAccessible(true);
            instance.set(null, null);
        } catch (Exception e) {
            // Ignore
        }
        app.getSharedPreferences("gateway_prefs", 0).edit().clear().commit();
        app.getSharedPreferences("gsm_audio_config", 0).edit().clear().commit();
        app.getSharedPreferences("device_mute_prefs", 0).edit().clear().commit();
        GatewayConfig.init(app);
        config = GatewayConfig.getInstance();
    }

    @Test
    public void testSingletonPattern() {
        GatewayConfig config2 = GatewayConfig.getInstance();
        assertSame("Should return same instance", config, config2);
    }

    @Test
    public void testDefaultSipValues() {
        // Default values should be empty or sensible defaults
        assertEquals("Default SIP server should be empty", "", config.getSipServer());
        assertEquals("Default SIP port should be 5060", 5060, config.getSipPort());
        assertEquals("Default realm should be *", "*", config.getSipRealm());
        assertTrue("TLS should be enabled by default", config.isUseTls());
    }

    @Test
    public void testSetSipConfig() {
        config.updateSipConfig("sip.example.com", 5080, "user", "pass", "realm", true);

        assertEquals("SIP server should be set", "sip.example.com", config.getSipServer());
        assertEquals("SIP port should be set", 5080, config.getSipPort());
        assertEquals("SIP user should be set", "user", config.getSipUser());
        assertEquals("SIP password should be set", "pass", config.getSipPassword());
        assertEquals("SIP realm should be set", "realm", config.getSipRealm());
        assertTrue("TLS should be enabled", config.isUseTls());
    }

    @Test
    public void testEffectiveSipPort() {
        // UDP: should use configured port
        config.updateSipConfig("test", 5060, "u", "p", "*", false);
        assertEquals("Effective port for UDP should be configured port", 5060, config.getEffectiveSipPort());

        // TLS: should use TLS port
        config.updateSipConfig("test", 5060, "u", "p", "*", true);
        assertEquals("Effective port for TLS should be 5061", 5061, config.getEffectiveSipPort());
    }

    @Test
    public void testSimDestinations() {
        config.updateSimDestinations("101", "102");

        assertEquals("SIM1 destination should be set", "101", config.getSim1Destination());
        assertEquals("SIM2 destination should be set", "102", config.getSim2Destination());
    }

    @Test
    public void testGetDestinationForSim() {
        config.updateSimDestinations("101", "102");

        assertEquals("SIM1 should map to 101", "101", config.getDestinationForSim(1));
        assertEquals("SIM2 should map to 102", "102", config.getDestinationForSim(2));
        assertEquals("Unknown SIM should return SIM1 destination", "101", config.getDestinationForSim(0));
        assertEquals("Unknown SIM should return SIM1 destination", "101", config.getDestinationForSim(99));
    }

    @Test
    public void testGetSimSlotForCaller() {
        config.updateSimDestinations("101", "102");

        assertEquals("Extension 101 should map to SIM1", 1, config.getSimSlotForCaller("101"));
        assertEquals("Extension 102 should map to SIM2", 2, config.getSimSlotForCaller("102"));
        assertEquals("Unknown extension should default to SIM1", 1, config.getSimSlotForCaller("999"));
    }

    @Test
    public void testAudioConfig() {
        assertEquals("Default audio card should be 0", 0, config.getAudioCard());
        assertEquals("Pixel capture PCM should default to MultiMedia1", 0, config.getCaptureDevice());
        assertEquals("Pixel injection PCM should default to MultiMedia9", 27, config.getPlaybackDevice());
        assertEquals("Pixel capture route should be verified default",
            "MultiMedia1", config.getCaptureRoute());
        assertEquals("Pixel injection route should be verified default",
            "MultiMedia9", config.getInjectionRoute());
        assertEquals("Pixel safe profile should be the default", "pixel_3_xl", config.getMutePreset());
    }

    @Test
    public void testLinphoneServiceDetection() {
        config.setSipServer("sip.linphone.org");
        assertTrue(config.isLinphoneService());
        config.setSipServer("pbx.example.com");
        assertFalse(config.isLinphoneService());
    }

    @Test
    public void testAuthorizedSipCallers() {
        config.updateSimDestinations("hiicash01", "backup01");
        assertTrue(config.isAuthorizedSipCaller("hiicash01"));
        assertTrue(config.isAuthorizedSipCaller("backup01"));
        assertFalse(config.isAuthorizedSipCaller("unknown"));
        assertFalse(config.isAuthorizedSipCaller(""));
        assertFalse(config.isAuthorizedSipCaller(null));
    }

    @Test
    public void testSeparateAudioRoutes() {
        config.updateAudioConfig(0, 4, 27, "MultiMedia4", "MultiMedia9");

        assertEquals(4, config.getCaptureDevice());
        assertEquals(27, config.getPlaybackDevice());
        assertEquals("MultiMedia4", config.getCaptureRoute());
        assertEquals("MultiMedia9", config.getInjectionRoute());
    }

    @Test
    public void testLegacyAudioRouteMigration() {
        Application app = RuntimeEnvironment.getApplication();
        app.getSharedPreferences("gsm_audio_config", 0).edit()
            .putString("multimedia_route", "MultiMedia2")
            .commit();

        assertEquals("MultiMedia2", config.getCaptureRoute());
        assertEquals("MultiMedia2", config.getInjectionRoute());
    }

    @Test
    public void testConstants() {
        // Verify constants are sensible
        assertEquals("Reconnect initial delay should be 5000ms", 5000, GatewayConfig.RECONNECT_INITIAL_DELAY_MS);
        assertEquals("Reconnect max delay should be 60000ms", 60000, GatewayConfig.RECONNECT_MAX_DELAY_MS);
        assertEquals("Reconnect multiplier should be 2", 2, GatewayConfig.RECONNECT_MULTIPLIER);
        assertEquals("Watchdog interval should be 3000ms", 3000, GatewayConfig.WATCHDOG_INTERVAL_MS);
    }
}
