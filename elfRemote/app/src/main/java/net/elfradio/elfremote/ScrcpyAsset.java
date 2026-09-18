package net.elfradio.elfremote;

import android.content.Context;
import java.io.*;
import java.security.MessageDigest;

/** 官方 scrcpy 服务端原样随 APK 分发（Apache-2.0，版本永久固定）；释放到核心目录并按哈希校验，失败由核心安装流程反复重试。 */
final class ScrcpyAsset {
    static final String VERSION = "3.3.3";
    static final String SHA256 = "7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0";
    static final String ASSET = "scrcpy-server";
    static final String TARGET = CoreInstaller.DIR + "/scrcpy-server";
    private static volatile boolean ready;

    static boolean ready() { return ready; }
    static void setReady(boolean value) { ready = value; }

    /** 把资源解出到应用私有暂存目录；已存在且哈希正确则直接复用。 */
    static File stage(Context context) throws Exception {
        File stage = new File(context.getFilesDir(), "core-stage");
        if (!stage.isDirectory() && !stage.mkdirs()) throw new IOException("core-stage");
        File file = new File(stage, ASSET);
        if (file.isFile() && SHA256.equals(RescueFiles.sha256(file))) return file;
        File temporary = new File(stage, ASSET + ".tmp");
        try (InputStream in = context.getAssets().open(ASSET); FileOutputStream out = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[32768]; int n; long length = 0;
            while ((n = in.read(buffer)) != -1) { length += n; if (length > 4L * 1024 * 1024) throw new IOException("scrcpy-asset-too-large"); out.write(buffer, 0, n); }
            out.getFD().sync();
        }
        if (!SHA256.equals(RescueFiles.sha256(temporary))) { temporary.delete(); throw new IOException("scrcpy-asset-hash"); }
        if (!temporary.renameTo(file)) throw new IOException("scrcpy-asset-rename");
        return file;
    }

    /** root 脚本：目标缺失或哈希不符才复制；shell(uid 2000) 需可读，因此文件 0644、目录可穿越。 */
    static String installScript(File staged) {
        String q = RescueFiles.quote(staged.getPath());
        // 父目录保持 setgid 与组读写（应用要写 pending.apk），只加 o+x 让 uid 2000 能穿越；核心目录同理。
        return "chmod 2771 /data/local/elfremote\nchmod 0711 " + CoreInstaller.DIR + "\n"
                + "if [ \"$(sha256sum " + TARGET + " 2>/dev/null | cut -d ' ' -f 1)\" != " + SHA256 + " ]; then\n"
                + "  cp " + q + " " + TARGET + ".new\n"
                + "  test \"$(sha256sum " + TARGET + ".new | cut -d ' ' -f 1)\" = " + SHA256 + "\n"
                + "  chmod 0644 " + TARGET + ".new\n  mv " + TARGET + ".new " + TARGET + "\nfi\n"
                + "chmod 0644 " + TARGET + "\n"
                + "test \"$(sha256sum " + TARGET + " | cut -d ' ' -f 1)\" = " + SHA256 + "\n";
    }

    /** 核心进程内自检（供 /health 与桌面启动前使用）。 */
    static boolean verifyInstalled() {
        try {
            File file = new File(TARGET);
            if (!file.isFile()) return false;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(file)) { byte[] b = new byte[32768]; int n; while ((n = in.read(b)) != -1) digest.update(b, 0, n); }
            StringBuilder hex = new StringBuilder();
            for (byte x : digest.digest()) hex.append(String.format("%02x", x));
            return SHA256.contentEquals(hex);
        } catch (Exception error) { return false; }
    }
    private ScrcpyAsset() {}
}
