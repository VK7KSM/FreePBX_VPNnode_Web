package net.elfradio.elfremote;

import java.io.File;

/** 以应用UID验证既有守护回退，不撤销真实Magisk授权。 */
public final class BootstrapBridgeProbe {
    public static void main(String[] args) throws Exception {
        int uid = android.os.Process.myUid();
        if (uid < 10000) throw new IllegalStateException("必须以elfRemote实际应用UID执行");
        File root = new File("/data/user/0/net.elfradio.elfremote/files");
        if (android.system.Os.stat(root.getPath()).st_uid != uid) throw new IllegalStateException("应用UID不一致");
        File script = new File(root, "bootstrap-check-" + System.currentTimeMillis() + ".sh");
        File output = new File(script.getPath() + ".out");
        RescueFiles.write(script, "#!/system/bin/sh\nid -u\n");
        BootstrapRoot.throughWatchdog(script, output, 10);
        if (!"0".equals(RescueFiles.read(output, 4096).trim())) throw new IllegalStateException("守护未以root执行");
        System.out.println("APPLICATION_UID_VERIFIED\nEXISTING_WATCHDOG_ROOT_OK\nQUEUE_RECEIPT_VERIFIED");
    }
}
