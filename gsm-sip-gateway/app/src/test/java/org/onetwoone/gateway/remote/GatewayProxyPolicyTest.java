package org.onetwoone.gateway.remote;

import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.*;

public class GatewayProxyPolicyTest {
    private static byte[] config(String extra){return ("allow-lan: false\n"
            +"bind-address: 127.0.0.1\nport: 17890\nsocks-port: 17891\nmixed-port: 0\nredir-port: 0\ntproxy-port: 0\n"
            +"proxies: []\nrules: [MATCH,DIRECT]\n"+extra).getBytes(StandardCharsets.UTF_8);}
    @Test public void acceptsOnlyPrivateConfigPath(){
        assertTrue(GatewayProxyPolicy.safeSource("/data/user/0/org.onetwoone.gateway/files/proxy-config/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.yaml"));
        assertFalse(GatewayProxyPolicy.safeSource("/sdcard/config.yaml"));
        assertFalse(GatewayProxyPolicy.safeSource("/data/user/0/org.onetwoone.gateway/files/proxy-config/../config.yaml"));
    }
    @Test public void acceptsFixedLoopbackListeners()throws Exception {GatewayProxyPolicy.validateConfig(config(""));}
    @Test public void rejectsLanTunAndDuplicateOverrides()throws Exception {
        for(String unsafe:new String[]{"tun:\n  enable: true\n","listeners: []\n","external-controller: 0.0.0.0:9090\n","external-controller-unix: /tmp/control.sock\n","dns:\n  listen: 0.0.0.0:53\n","allow-lan: true\n","port: 8080\n"}){
            try{GatewayProxyPolicy.validateConfig(config(unsafe));fail("accepted "+unsafe);}catch(SecurityException expected){}
        }
    }
    @Test public void quotedScalarsAndCommentsRemainValid()throws Exception {
        GatewayProxyPolicy.validateConfig(("allow-lan: false # local only\nbind-address: '127.0.0.1'\nport: 17890\nsocks-port: 17891\nmixed-port: 0\nredir-port: 0\ntproxy-port: 0\nproxies: []\n").getBytes(StandardCharsets.UTF_8));
    }
}
