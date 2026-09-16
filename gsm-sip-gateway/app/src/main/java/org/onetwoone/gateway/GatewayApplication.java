package org.onetwoone.gateway;

import android.app.Application;
import org.onetwoone.gateway.config.GatewayConfig;

/**
 * Application class for gateway initialization.
 *
 * Initializes process-wide configuration before any service or UI uses it.
 */
public class GatewayApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        GatewayConfig.init(this);
    }
}
