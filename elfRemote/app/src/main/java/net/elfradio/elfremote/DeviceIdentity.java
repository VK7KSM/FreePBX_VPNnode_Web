package net.elfradio.elfremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.FileReader;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

final class DeviceIdentity {
    private final SharedPreferences prefs;
    private long retryAt;
    DeviceIdentity(Context context) { prefs=context.getSharedPreferences("elfremote-identity",Context.MODE_PRIVATE); }

    JSONObject read() {
        if (!"k39tv1_64_bsp".equals(Build.DEVICE)) return null;
        String mac=HardwareIdentityPolicy.normalize(prefs.getString("nvdata_mac", ""));
        if (mac.isEmpty() && SystemClock.elapsedRealtime() >= retryAt) {
            retryAt=SystemClock.elapsedRealtime()+60000L;
            mac=readNvdata();
            if (!mac.isEmpty()) prefs.edit().putString("nvdata_mac",mac).commit();
        }
        if (mac.isEmpty()) return null;
        try { return new JSONObject().put("variant","d22").put("kind","wifi_factory_mac")
                .put("source","nvdata_wifi").put("value",mac); }
        catch (Exception error) { return null; }
    }

    private String readNvdata() {
        // XX已验证此目录挂载独立nvdata分区；不把vendor镜像中的模板当作本机身份。
        boolean mounted=false;
        try (BufferedReader reader=new BufferedReader(new FileReader("/proc/mounts"))) {
            String line;
            while ((line=reader.readLine())!=null) {
                String[] fields=line.split(" ");
                if (fields.length>2 && fields[0].startsWith("/dev/block/") && fields[1].equals("/vendor/nvdata")) mounted=true;
            }
        } catch (Exception ignored) { return ""; }
        if (!mounted) return "";
        java.lang.Process process=null;
        try {
            process=new ProcessBuilder("su","-c","dd if=/vendor/nvdata/APCFG/APRDEB/WIFI bs=1 skip=4 count=6 2>/dev/null").start();
            if (!process.waitFor(5,TimeUnit.SECONDS) || process.exitValue()!=0) return "";
            ByteArrayOutputStream out=new ByteArrayOutputStream();
            int b;
            while ((b=process.getInputStream().read())!=-1 && out.size()<7) out.write(b);
            return HardwareIdentityPolicy.fromBytes(out.toByteArray());
        } catch (Exception ignored) { return ""; }
        finally { if (process!=null) process.destroy(); }
    }
}
