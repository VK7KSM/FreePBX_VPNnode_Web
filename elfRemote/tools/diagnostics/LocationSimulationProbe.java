package net.elfradio.elfremote.diagnostics;

import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.os.Looper;
import android.os.SystemClock;
import android.system.Os;
import java.io.File;
import java.io.FileInputStream;
import org.json.JSONObject;

/** 有时间上限的真机模拟工具；只替换系统测试定位源，不改客户端或位置判定代码。 */
public final class LocationSimulationProbe {
    public static void main(String[] args) {
        LocationManager manager = null;
        boolean gps = false, network = false;
        int exit = 1;
        try {
            if (android.os.Process.myUid() != 0) throw new IllegalStateException("须由已授权的远程维护通道启动");
            if (args.length != 1 && args.length != 3) throw new IllegalArgumentException("read 或 run 控制文件");
            Os.setgid(2000); Os.setuid(2000);
            Looper.prepareMainLooper();
            Object at = Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null);
            Context system = (Context) at.getClass().getMethod("getSystemContext").invoke(at);
            Context context = system.createPackageContext("com.android.shell", Context.CONTEXT_IGNORE_SECURITY);
            if (context.getApplicationInfo().uid != android.os.Process.myUid()) throw new IllegalStateException("包名与调用身份不一致");
            manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
            System.out.println(new JSONObject().put("phase", "baseline").put("uid", android.os.Process.myUid())
                    .put("package", context.getPackageName()).put("gps_enabled", manager.isProviderEnabled("gps"))
                    .put("network_enabled", manager.isProviderEnabled("network")));
            if ("read".equals(args[0])) { exit = 0; return; }
            if ("cleanup".equals(args[0])) {
                for (String provider : new String[]{"network", "gps"}) {
                    try { manager.removeTestProvider(provider); }
                    catch (IllegalArgumentException absent) { System.out.println("NO_TEST_PROVIDER " + provider); }
                }
                exit = 0; return;
            }
            if (!"run".equals(args[0]) || !"--bounded".equals(args[2])) throw new IllegalArgumentException("必须指定有界模式");
            File control = new File(args[1]);
            // 两个测试源都不送数据时可覆盖旧缓存；系统总定位开关和无线扫描保持原值。
            manager.addTestProvider("gps", false, true, false, false, true, true, true, 3, 1); gps = true;
            manager.addTestProvider("network", true, false, true, false, false, false, false, 1, 2); network = true;
            manager.setTestProviderEnabled("gps", true); manager.setTestProviderEnabled("network", true);
            long deadline = SystemClock.elapsedRealtime() + 900000L;
            System.out.println("SIMULATION_READY"); System.out.flush();
            String previous = "";
            while (SystemClock.elapsedRealtime() < deadline) {
                JSONObject input;
                try (FileInputStream in = new FileInputStream(control)) {
                    byte[] bytes = new byte[2048]; int n = in.read(bytes);
                    if (n <= 0 || in.read() != -1) throw new IllegalArgumentException("控制文件为空或过大");
                    input = new JSONObject(new String(bytes, 0, n, "UTF-8"));
                }
                String mode = input.getString("mode");
                if ("stop".equals(mode)) break;
                if (!mode.equals(previous)) { System.out.println("SIMULATION_MODE " + mode); System.out.flush(); previous = mode; }
                if ("fix".equals(mode)) {
                    double lat = input.getDouble("lat"), lng = input.getDouble("lng");
                    if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) throw new IllegalArgumentException("坐标无效");
                    Location point = new Location("gps");point.setLatitude(lat);point.setLongitude(lng);
                    point.setAccuracy(5);point.setAltitude(0);point.setSpeed(0);point.setBearing(0);
                    point.setTime(System.currentTimeMillis());point.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
                    manager.setTestProviderLocation("gps", point);
                } else if (!"empty".equals(mode)) throw new IllegalArgumentException("未知模拟模式");
                Thread.sleep(1000);
            }
            exit = 0;
        } catch (Throwable error) { error.printStackTrace(System.out); }
        finally {
            if (manager != null) {
                if (network) try { manager.removeTestProvider("network"); } catch (Throwable error) { exit=2;error.printStackTrace(System.out); }
                if (gps) try { manager.removeTestProvider("gps"); } catch (Throwable error) { exit=2;error.printStackTrace(System.out); }
            }
            System.out.println("SIMULATION_EXIT " + exit);System.out.flush();System.exit(exit);
        }
    }
}
