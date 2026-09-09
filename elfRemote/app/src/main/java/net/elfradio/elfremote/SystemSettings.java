package net.elfradio.elfremote;

import android.app.*;
import android.bluetooth.*;
import android.content.*;
import android.content.pm.*;
import android.content.res.Configuration;
import android.media.AudioManager;
import android.net.*;
import android.net.wifi.*;
import android.os.*;
import android.provider.Settings;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

/** 按需运行的系统配置工具；独立进程使超时与主维护核心隔离。 */
public final class SystemSettings {
    private Context context;
    private WifiManager wifi;
    private ContentResolver resolver;
    private File folder;
    private static final String[] VOLUMES={"media","ring","alarm","call"};
    private static final int[] STREAMS={3,2,4,0};

    static JSONObject normalize(JSONObject p)throws Exception {
        String group=p.getString("group"),action=p.optString("action","read");
        if(!Arrays.asList("wifi","network","apps","sound","time").contains(group)||!Arrays.asList("read","set").contains(action))throw new IOException("系统配置项目无效");
        JSONObject n=new JSONObject().put("group",group).put("action",action);
        String pkg=p.optString("package","");if(!pkg.isEmpty()&&!pkg.matches("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+"))throw new IOException("应用包名无效");
        n.put("package",pkg);int offset=p.optInt("offset",0);if(offset<0||offset>10000)throw new IOException("分页无效");n.put("offset",offset);
        if(action.equals("set")) {
            String key=p.getString("key");Object value=p.get("value");
            Map<String,List<String>> keys=new HashMap<>();
            keys.put("sound",Arrays.asList("media","ring","alarm","call","brightness","brightness_auto","font_scale"));
            keys.put("time",Arrays.asList("locale","auto_time","auto_time_zone","timezone"));
            keys.put("network",Arrays.asList("mobile_data","bluetooth","hotspot","dns"));
            keys.put("wifi",Arrays.asList("connect"));keys.put("apps",Arrays.asList("enabled","permission","notifications","background"));
            if(!keys.get(group).contains(key))throw new IOException("该分类没有此设置");
            if(Arrays.asList("brightness_auto","auto_time","auto_time_zone","mobile_data","bluetooth","enabled","notifications","background").contains(key)&&!(value instanceof Boolean))throw new IOException("开关值无效");
            if(Arrays.asList("media","ring","alarm","call","brightness","font_scale").contains(key)) {
                if(!(value instanceof Number)||!Double.isFinite(((Number)value).doubleValue()))throw new IOException("数值无效");
                double v=((Number)value).doubleValue();if(key.equals("font_scale")?(v<.85||v>1.5):(v<0||v>255||v!=Math.floor(v)))throw new IOException("数值超出范围");
            }
            if(key.equals("timezone")&&(!(value instanceof String)||!Arrays.asList(TimeZone.getAvailableIDs()).contains(value)))throw new IOException("时区无效");
            if(key.equals("locale")&&(!(value instanceof String)||!((String)value).matches("[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}")))throw new IOException("语言无效");
            if(group.equals("apps")&&pkg.isEmpty())throw new IOException("请先选择应用");
            if(key.equals("permission")){JSONObject v=p.getJSONObject("value");String permission=v.getString("name");if(!permission.matches("[A-Za-z0-9_.]+")||!(v.get("granted") instanceof Boolean))throw new IOException("权限参数无效");}
            if(key.equals("connect")){JSONObject v=p.getJSONObject("value");ConfigPolicy.wifi(v);}
            if(key.equals("hotspot")){JSONObject v=p.getJSONObject("value");if(!(v.get("enabled") instanceof Boolean))throw new IOException("热点状态无效");if(v.optBoolean("enabled")){String ssid=v.getString("ssid"),password=v.optString("password","");ConfigPolicy.wifi(new JSONObject().put("ssid",ssid).put("password",password));if(password.isEmpty())throw new IOException("请设置热点密码");}}
            if(key.equals("dns")){JSONObject v=p.getJSONObject("value");if(!Arrays.asList("auto","manual").contains(v.getString("mode")))throw new IOException("DNS模式无效");if(v.getString("mode").equals("manual")){JSONArray servers=v.getJSONArray("servers");if(servers.length()<1||servers.length()>2)throw new IOException("请填写1至2个DNS地址");for(int i=0;i<servers.length();i++)if(!servers.getString(i).matches("[0-9a-fA-F:.]+")||InetAddress.getByName(servers.getString(i)).isAnyLocalAddress())throw new IOException("DNS地址无效");}}
            n.put("key",key).put("value",value);
        }
        if(n.toString().length()>6000)throw new IOException("设置参数过大");return n;
    }

    static JSONObject execute(File folder,JSONObject params)throws Exception {
        JSONObject p=normalize(params);File request=new File(folder,"settings-request.json");RescueFiles.write(request,p.toString());
        String command="CLASSPATH="+RescueFiles.quote(System.getProperty("java.class.path"))+" app_process /system/bin net.elfradio.elfremote.SystemSettings "+RescueFiles.quote(folder.getPath());
        JSONObject result=RescueDaemon.execute(folder,command,120);
        // 密码不进入命令记录或结果，任务结束移除临时参数。
        request.delete();return result;
    }

    public static void main(String[] args) {
        int exit=1;
        try {
            if(android.os.Process.myUid()!=0||args.length<1)throw new IOException("需要独立维护权限");
            SystemSettings tool=new SystemSettings();tool.folder=new File(args[0]);
            if(!tool.folder.getCanonicalPath().startsWith(CoreInstaller.DIR+"/jobs/"))throw new IOException("配置任务目录无效");
            tool.context=CoreWake.systemContext();tool.resolver=tool.context.getContentResolver();tool.wifi=(WifiManager)tool.context.getSystemService(Context.WIFI_SERVICE);
            if(args.length==2&&args[1].equals("rollback")){tool.guard();exit=0;}
            else {JSONObject p=normalize(new JSONObject(RescueFiles.read(new File(tool.folder,"settings-request.json"),16000)));JSONObject result=tool.perform(p);System.out.println(result);exit=0;}
        }catch(Throwable failure){Throwable e=failure;while(e instanceof InvocationTargetException&&e.getCause()!=null)e=e.getCause();System.out.println("系统配置未完成："+e.getClass().getSimpleName()+" · "+String.valueOf(e.getMessage()));}
        System.exit(exit);
    }

    private JSONObject perform(JSONObject p)throws Exception {
        String group=p.getString("group");JSONObject before=snapshot(p);
        if(p.getString("action").equals("read"))return before;
        String key=p.getString("key");Object old=oldValue(p,before);
        boolean network=group.equals("wifi")||(group.equals("network")&&!key.equals("bluetooth"));
        RescueFiles.write(new File(folder,"settings-before.json"),new JSONObject().put("params",p).put("old",old).put("snapshot",before).toString());
        if(network)armGuard(p);
        try {
            change(p,p.get("value"));
            if(network) {
                long until=SystemClock.elapsedRealtime()+70000;boolean ok=false;
                while(SystemClock.elapsedRealtime()<until){Thread.sleep(1500);if(matches(p,snapshot(p))&&reachesServer()){ok=true;break;}}
                if(!ok)throw new IOException("更改后无法确认网络连接，正在恢复原设置");
            }else {Thread.sleep(500);if(!matches(p,snapshot(p)))throw new IOException("设备读回值与设置不一致");}
            if(network)RescueFiles.write(new File(folder,"settings-commit"),"ok");
            JSONObject result=snapshot(p);result.put("applied",true);return result;
        }catch(Exception error){
            boolean restored=false;
            try{if(network)restoreNetwork();else {change(p,old);if(!matches(new JSONObject(p.toString()).put("value",old),snapshot(p)))throw new IOException("原值读回不符");}restored=true;if(network)RescueFiles.write(new File(folder,"settings-commit"),"restored");}catch(Exception restore){ }
            throw new IOException((restored?"修改失败，已执行原设置恢复":"修改失败，原设置恢复尚未完成")+"（"+rootType(error)+"）");
        }
    }
    private static String rootType(Throwable e){while(e.getCause()!=null)e=e.getCause();return e.getClass().getSimpleName()+": "+e.getMessage();}
    private Object oldValue(JSONObject p,JSONObject before)throws Exception {
        if(p.getString("group").equals("wifi"))return JSONObject.NULL;
        if(p.getString("key").equals("permission")){JSONObject v=p.getJSONObject("value");return new JSONObject().put("name",v.getString("name")).put("granted",context.getPackageManager().checkPermission(v.getString("name"),p.getString("package"))==PackageManager.PERMISSION_GRANTED);}
        return before.opt(p.getString("key"))==null?JSONObject.NULL:before.get(p.getString("key"));
    }
    private JSONObject snapshot(JSONObject p)throws Exception {
        String group=p.getString("group");JSONObject out=new JSONObject().put("group",group).put("sampled_at",System.currentTimeMillis());
        if(group.equals("sound")) {
            AudioManager a=(AudioManager)context.getSystemService(Context.AUDIO_SERVICE);JSONObject max=new JSONObject();
            for(int i=0;i<VOLUMES.length;i++){out.put(VOLUMES[i],a.getStreamVolume(STREAMS[i]));max.put(VOLUMES[i],a.getStreamMaxVolume(STREAMS[i]));}
            out.put("maximum",max).put("brightness",Settings.System.getInt(resolver,"screen_brightness",102)).put("brightness_auto",Settings.System.getInt(resolver,"screen_brightness_mode",0)==1).put("font_scale",Settings.System.getFloat(resolver,"font_scale",1));
        }else if(group.equals("time")){
            Configuration config=configuration();out.put("locale",config.getLocales().get(0).toLanguageTag()).put("timezone",property("persist.sys.timezone"))
                .put("auto_time",Settings.Global.getInt(resolver,"auto_time",1)==1).put("auto_time_zone",Settings.Global.getInt(resolver,"auto_time_zone",1)==1);
            JSONArray locales=new JSONArray();for(String locale:context.getAssets().getLocales())if(!locale.equals("en-XA")&&!locale.equals("ar-XB"))locales.put(locale.replace('_','-'));out.put("locales",locales);
        }else if(group.equals("apps")) {
            String pkg=p.optString("package");PackageManager pm=context.getPackageManager();
            if(pkg.isEmpty()) {
                List<ApplicationInfo> apps=pm.getInstalledApplications(0);apps.sort(Comparator.comparing(a->a.packageName));JSONArray rows=new JSONArray();int offset=p.optInt("offset");
                for(int i=offset;i<Math.min(apps.size(),offset+15);i++){ApplicationInfo a=apps.get(i);rows.put(new JSONObject().put("package",a.packageName).put("name",a.loadLabel(pm).toString()).put("enabled",a.enabled).put("system",(a.flags&ApplicationInfo.FLAG_SYSTEM)!=0));}
                out.put("apps",rows).put("offset",offset).put("total",apps.size()).put("next",offset+15<apps.size()?offset+15:-1);
            } else {
                PackageInfo app=pm.getPackageInfo(pkg,PackageManager.GET_PERMISSIONS);int uid=app.applicationInfo.uid;JSONArray permissions=new JSONArray();
                if(app.requestedPermissions!=null)for(String name:app.requestedPermissions)try{PermissionInfo info=pm.getPermissionInfo(name,0);if((info.protectionLevel&PermissionInfo.PROTECTION_MASK_BASE)!=PermissionInfo.PROTECTION_DANGEROUS)continue;
                    permissions.put(new JSONObject().put("name",name).put("label",info.loadLabel(pm)).put("granted",pm.checkPermission(name,pkg)==PackageManager.PERMISSION_GRANTED));}catch(PackageManager.NameNotFoundException ignored){}
                out.put("package",pkg).put("name",app.applicationInfo.loadLabel(pm)).put("version",app.versionName).put("enabled",app.applicationInfo.enabled).put("permissions",permissions)
                    .put("notifications",Class.forName("android.app.INotificationManager").getMethod("areNotificationsEnabledForPackage",String.class,int.class).invoke(notificationService(),pkg,uid))
                    .put("background",((AppOpsManager)context.getSystemService(Context.APP_OPS_SERVICE)).checkOpNoThrow("android:run_in_background",uid,pkg)!=AppOpsManager.MODE_IGNORED);
            }
        }else {
            ConnectivityManager cm=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);Network n=cm.getActiveNetwork();LinkProperties link=n==null?null:cm.getLinkProperties(n);
            WifiInfo current=wifi.getConnectionInfo();JSONArray saved=new JSONArray();List<WifiConfiguration> configs=wifi.getConfiguredNetworks();if(configs!=null)for(WifiConfiguration c:configs)saved.put(new JSONObject().put("id",c.networkId).put("ssid",unquote(c.SSID)));
            out.put("wifi_enabled",wifi.isWifiEnabled()).put("ssid",current==null?"":unquote(current.getSSID())).put("network_id",current==null?-1:current.getNetworkId()).put("saved",saved);
            if(group.equals("network")){
                out.put("mobile_data",Settings.Global.getInt(resolver,"mobile_data",0)==1).put("usb",property("sys.usb.state"));
                BluetoothAdapter bt=BluetoothAdapter.getDefaultAdapter();out.put("bluetooth_supported",bt!=null).put("bluetooth",bt!=null&&bt.isEnabled());JSONArray paired=new JSONArray();if(bt!=null&&bt.isEnabled())for(BluetoothDevice d:bt.getBondedDevices())paired.put(new JSONObject().put("name",d.getName()).put("address",d.getAddress()));out.put("paired",paired);
                WifiConfiguration ap=(WifiConfiguration)wifi.getClass().getMethod("getWifiApConfiguration").invoke(wifi);int state=(Integer)wifi.getClass().getMethod("getWifiApState").invoke(wifi);
                out.put("hotspot",new JSONObject().put("enabled",state==13).put("ssid",ap==null?"":unquote(ap.SSID)));
                JSONArray dns=new JSONArray();if(link!=null)for(InetAddress address:link.getDnsServers())dns.put(address.getHostAddress());WifiConfiguration active=findConfig(current==null?-1:current.getNetworkId(),false);
                String mode="auto";if(active!=null){Object ip=active.getClass().getMethod("getIpConfiguration").invoke(active);mode="STATIC".equals(String.valueOf(ip.getClass().getMethod("getIpAssignment").invoke(ip)))?"manual":"auto";}
                out.put("dns",new JSONObject().put("mode",mode).put("servers",dns)).put("dns_editable",active!=null);
            }
        }
        return out;
    }
    private void change(JSONObject p,Object value)throws Exception {
        String group=p.getString("group"),key=p.getString("key");
        if(group.equals("sound")) {
            int i=Arrays.asList(VOLUMES).indexOf(key);if(i>=0){AudioManager a=(AudioManager)context.getSystemService(Context.AUDIO_SERVICE);int v=((Number)value).intValue();if(v>a.getStreamMaxVolume(STREAMS[i]))throw new IOException("音量超出设备范围");a.setStreamVolume(STREAMS[i],v,0);}
            else if(key.equals("font_scale")){Configuration c=configuration();c.fontScale=((Number)value).floatValue();updateConfiguration(c);}
            else if(!Settings.System.putInt(resolver,key.equals("brightness_auto")?"screen_brightness_mode":"screen_brightness",key.equals("brightness_auto")?((Boolean)value?1:0):((Number)value).intValue()))throw new IOException("设置写入失败");
        }else if(group.equals("time")) {
            if(key.equals("timezone"))((AlarmManager)context.getSystemService(Context.ALARM_SERVICE)).setTimeZone((String)value);
            else if(key.equals("locale")){Configuration c=configuration();c.setLocales(LocaleList.forLanguageTags((String)value));Configuration.class.getField("userSetLocale").setBoolean(c,true);updateConfiguration(c);}
            else if(!Settings.Global.putInt(resolver,key,(Boolean)value?1:0))throw new IOException("设置写入失败");
        }else if(group.equals("apps")) {
            String pkg=p.getString("package");PackageManager pm=context.getPackageManager();int uid=pm.getApplicationInfo(pkg,0).uid;
            if(key.equals("enabled"))pm.setApplicationEnabledSetting(pkg,(Boolean)value?PackageManager.COMPONENT_ENABLED_STATE_ENABLED:PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,0);
            else if(key.equals("permission")){JSONObject v=(JSONObject)value;PermissionInfo info=pm.getPermissionInfo(v.getString("name"),0);if((info.protectionLevel&PermissionInfo.PROTECTION_MASK_BASE)!=PermissionInfo.PROTECTION_DANGEROUS)throw new IOException("此权限不是可调整的运行时权限");
                pm.getClass().getMethod(v.getBoolean("granted")?"grantRuntimePermission":"revokeRuntimePermission",String.class,String.class,UserHandle.class).invoke(pm,pkg,v.getString("name"),UserHandle.getUserHandleForUid(uid));}
            else if(key.equals("notifications")){Object service=notificationService();Class.forName("android.app.INotificationManager").getMethod("setNotificationsEnabledForPackage",String.class,int.class,boolean.class).invoke(service,pkg,uid,(Boolean)value);}
            else {AppOpsManager ops=(AppOpsManager)context.getSystemService(Context.APP_OPS_SERVICE);ops.getClass().getMethod("setMode",String.class,int.class,String.class,int.class).invoke(ops,"android:run_in_background",uid,pkg,(Boolean)value?AppOpsManager.MODE_ALLOWED:AppOpsManager.MODE_IGNORED);}
        }else if(key.equals("mobile_data"))shell("svc data "+((Boolean)value?"enable":"disable"));
        else if(key.equals("bluetooth")){BluetoothAdapter b=BluetoothAdapter.getDefaultAdapter();if(b==null)throw new IOException("设备没有蓝牙适配器");if((Boolean)value)b.enable();else b.disable();for(int i=0;i<30&&b.isEnabled()!=(Boolean)value;i++)Thread.sleep(200);}
        else if(key.equals("hotspot")){JSONObject v=(JSONObject)value;WifiConfiguration c=null;if(v.getBoolean("enabled")){c=new WifiConfiguration();c.SSID=v.getString("ssid");c.preSharedKey=v.getString("password");c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);}
            if(!(Boolean)wifi.getClass().getMethod("setWifiApEnabled",WifiConfiguration.class,boolean.class).invoke(wifi,c,v.getBoolean("enabled")))throw new IOException("系统拒绝热点设置");}
        else if(key.equals("connect"))connectWifi((JSONObject)value);
        else if(key.equals("dns"))setDns((JSONObject)value);
    }
    private boolean matches(JSONObject p,JSONObject after)throws Exception {
        String key=p.getString("key");Object value=p.get("value");
        if(key.equals("connect")){WifiInfo info=wifi.getConnectionInfo();return info!=null&&info.getIpAddress()!=0&&unquote(info.getSSID()).equals(p.getJSONObject("value").getString("ssid"));}
        if(key.equals("hotspot")){JSONObject v=(JSONObject)value,got=after.getJSONObject("hotspot");return got.getBoolean("enabled")==v.getBoolean("enabled")&&(!v.getBoolean("enabled")||got.getString("ssid").equals(v.getString("ssid")));}
        if(key.equals("dns")){JSONObject want=(JSONObject)value,got=after.getJSONObject("dns");if(!want.getString("mode").equals(got.getString("mode")))return false;if(want.getString("mode").equals("auto"))return true;return want.getJSONArray("servers").toString().equals(got.getJSONArray("servers").toString());}
        if(key.equals("permission")){JSONObject v=(JSONObject)value;return (context.getPackageManager().checkPermission(v.getString("name"),p.getString("package"))==PackageManager.PERMISSION_GRANTED)==v.getBoolean("granted");}
        if(value instanceof Number)return Math.abs(((Number)value).doubleValue()-after.getDouble(key))<.001;
        return value.equals(after.get(key));
    }
    private WifiConfiguration findConfig(int id,boolean privileged)throws Exception {
        List<WifiConfiguration> all=privileged?(List<WifiConfiguration>)wifi.getClass().getMethod("getPrivilegedConfiguredNetworks").invoke(wifi):wifi.getConfiguredNetworks();
        if(all!=null)for(WifiConfiguration c:all)if(c.networkId==id)return c;return null;
    }
    private void connectWifi(JSONObject v)throws Exception {
        if(!wifi.isWifiEnabled()){wifi.setWifiEnabled(true);for(int i=0;i<30&&!wifi.isWifiEnabled();i++)Thread.sleep(200);}
        List<WifiConfiguration> all=wifi.getConfiguredNetworks();WifiConfiguration found=null;if(all!=null)for(WifiConfiguration c:all)if(unquote(c.SSID).equals(v.getString("ssid")))found=c;
        String password=v.optString("password","");int id;
        if(found!=null&&password.isEmpty())id=found.networkId;
        else {WifiConfiguration c=found==null?new WifiConfiguration():findConfig(found.networkId,true);if(c==null)throw new IOException("无法备份原Wi-Fi配置");
            c.SSID=ConfigPolicy.quoteWifi(v.getString("ssid"));c.allowedKeyManagement.clear();if(password.isEmpty()){c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);c.preSharedKey=null;}else{c.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);c.preSharedKey=password.matches("[0-9a-fA-F]{64}")?password:ConfigPolicy.quoteWifi(password);}
            id=found==null?wifi.addNetwork(c):wifi.updateNetwork(c);if(id<0)throw new IOException("系统拒绝Wi-Fi配置");}
        if(!wifi.enableNetwork(id,true)||!wifi.reconnect())throw new IOException("系统拒绝连接Wi-Fi");wifi.saveConfiguration();
    }
    private void setDns(JSONObject v)throws Exception {
        WifiConfiguration c=findConfig(wifi.getConnectionInfo().getNetworkId(),true);if(c==null)throw new IOException("DNS配置需要当前Wi-Fi连接");
        Object ip=c.getClass().getMethod("getIpConfiguration").invoke(c);Class<?> ipc=ip.getClass(),assignment=Class.forName("android.net.IpConfiguration$IpAssignment");
        if(v.getString("mode").equals("auto"))ipc.getMethod("setIpAssignment",assignment).invoke(ip,Enum.valueOf((Class)assignment,"DHCP"));
        else {ConnectivityManager cm=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);LinkProperties link=cm.getLinkProperties(cm.getActiveNetwork());Class<?> staticType=Class.forName("android.net.StaticIpConfiguration");Object cfg=staticType.getConstructor().newInstance();
            LinkAddress ipv4=null;InetAddress gateway=null;for(LinkAddress address:link.getLinkAddresses())if(address.getAddress() instanceof Inet4Address)ipv4=address;for(RouteInfo route:link.getRoutes())if(route.isDefaultRoute()&&route.getGateway() instanceof Inet4Address)gateway=route.getGateway();if(ipv4==null||gateway==null)throw new IOException("没有可保持的Wi-Fi地址与网关");
            staticType.getField("ipAddress").set(cfg,ipv4);staticType.getField("gateway").set(cfg,gateway);List<InetAddress> dns=(List<InetAddress>)staticType.getField("dnsServers").get(cfg);JSONArray addresses=v.getJSONArray("servers");for(int i=0;i<addresses.length();i++)dns.add(InetAddress.getByName(addresses.getString(i)));
            ipc.getMethod("setIpAssignment",assignment).invoke(ip,Enum.valueOf((Class)assignment,"STATIC"));ipc.getMethod("setStaticIpConfiguration",staticType).invoke(ip,cfg);
        }
        c.getClass().getMethod("setIpConfiguration",ipc).invoke(c,ip);if(wifi.updateNetwork(c)<0)throw new IOException("系统拒绝DNS配置");wifi.saveConfiguration();wifi.disconnect();wifi.enableNetwork(c.networkId,true);wifi.reconnect();
    }
    private void armGuard(JSONObject p)throws Exception {
        JSONArray configs=new JSONArray();List<WifiConfiguration> all=(List<WifiConfiguration>)wifi.getClass().getMethod("getPrivilegedConfiguredNetworks").invoke(wifi);
        if(all==null)throw new IOException("无法保存Wi-Fi恢复依据");for(WifiConfiguration c:all)configs.put(parcel(c));
        WifiConfiguration ap=(WifiConfiguration)wifi.getClass().getMethod("getWifiApConfiguration").invoke(wifi);JSONObject backup=new JSONObject().put("configs",configs).put("wifi",wifi.isWifiEnabled()).put("network_id",wifi.getConnectionInfo().getNetworkId()).put("mobile_data",Settings.Global.getInt(resolver,"mobile_data",0)==1)
            .put("ap",ap==null?JSONObject.NULL:parcel(ap)).put("ap_enabled",(Integer)wifi.getClass().getMethod("getWifiApState").invoke(wifi)==13);
        RescueFiles.write(new File(folder,"settings-network-before.json"),backup.toString());
        java.lang.Process guard=new ProcessBuilder("/system/bin/setsid","/system/bin/app_process","/system/bin",SystemSettings.class.getName(),folder.getPath(),"rollback").redirectErrorStream(true).redirectOutput(new File(folder,"settings-guard.log")).start();
        for(int i=0;i<50&&!new File(folder,"settings-guard-ready").exists();i++)Thread.sleep(100);if(!new File(folder,"settings-guard-ready").exists())throw new IOException("网络恢复守护未就绪");
    }
    private void guard()throws Exception {
        HandlerThread t=new HandlerThread("elfremote-settings-rollback");t.start();CountDownLatch fired=new CountDownLatch(1);AlarmManager alarms=(AlarmManager)context.getSystemService(Context.ALARM_SERVICE);AlarmManager.OnAlarmListener listener=fired::countDown;
        alarms.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP,SystemClock.elapsedRealtime()+95000,"elfRemote:settings-rollback",listener,new Handler(t.getLooper()));RescueFiles.write(new File(folder,"settings-guard-ready"),"ready");
        try {fired.await(110,TimeUnit.SECONDS);if(!new File(folder,"settings-commit").exists()){restoreNetwork();RescueFiles.write(new File(folder,"settings-restored"),"restored");}}
        finally{alarms.cancel(listener);t.quitSafely();}
    }
    private void restoreNetwork()throws Exception {
        JSONObject b=new JSONObject(RescueFiles.read(new File(folder,"settings-network-before.json"),300000));
        wifi.getClass().getMethod("setWifiApEnabled",WifiConfiguration.class,boolean.class).invoke(wifi,b.isNull("ap")?null:unparcel(b.getString("ap")),b.getBoolean("ap_enabled"));
        shell("svc data "+(b.getBoolean("mobile_data")?"enable":"disable"));wifi.setWifiEnabled(true);for(int i=0;i<30&&!wifi.isWifiEnabled();i++)Thread.sleep(200);
        Set<Integer> old=new HashSet<>();JSONArray saved=b.getJSONArray("configs");for(int i=0;i<saved.length();i++){WifiConfiguration c=unparcel(saved.getString(i));old.add(c.networkId);if(wifi.updateNetwork(c)<0)throw new IOException("Wi-Fi原配置恢复被拒绝");}
        List<WifiConfiguration> all=wifi.getConfiguredNetworks();if(all!=null)for(WifiConfiguration c:all)if(!old.contains(c.networkId))wifi.removeNetwork(c.networkId);
        for(int i=0;i<saved.length();i++){WifiConfiguration c=unparcel(saved.getString(i));if(c.status!=WifiConfiguration.Status.DISABLED)wifi.enableNetwork(c.networkId,false);}
        if(b.getBoolean("wifi")){int oldId=b.getInt("network_id");if(oldId>=0)wifi.enableNetwork(oldId,true);wifi.reconnect();}else wifi.setWifiEnabled(false);wifi.saveConfiguration();
    }
    private boolean reachesServer(){HttpsURLConnectionWrapper check=new HttpsURLConnectionWrapper();return check.ok();}
    private static final class HttpsURLConnectionWrapper {boolean ok(){javax.net.ssl.HttpsURLConnection c=null;try{c=(javax.net.ssl.HttpsURLConnection)new URL(BuildConfig.CONTROL_URL+"/").openConnection();c.setSSLSocketFactory(CoreTraffic.factory());c.setConnectTimeout(2500);c.setReadTimeout(2500);c.setRequestMethod("HEAD");c.setInstanceFollowRedirects(false);int code=c.getResponseCode();return code>=200&&code<400;}catch(Exception ignored){return false;}finally{if(c!=null)c.disconnect();}}}
    private static String parcel(WifiConfiguration c){Parcel p=Parcel.obtain();try{c.writeToParcel(p,0);return android.util.Base64.encodeToString(p.marshall(),android.util.Base64.NO_WRAP);}finally{p.recycle();}}
    private static WifiConfiguration unparcel(String s)throws Exception {Parcel p=Parcel.obtain();try{byte[] b=android.util.Base64.decode(s,0);p.unmarshall(b,0,b.length);p.setDataPosition(0);return ((Parcelable.Creator<WifiConfiguration>)WifiConfiguration.class.getField("CREATOR").get(null)).createFromParcel(p);}finally{p.recycle();}}
    private static String property(String key)throws Exception{return (String)Class.forName("android.os.SystemProperties").getMethod("get",String.class).invoke(null,key);}
    private static String unquote(String v){if(v==null||v.equals("<unknown ssid>"))return "";return v.length()>1&&v.startsWith("\"")&&v.endsWith("\"")?v.substring(1,v.length()-1):v;}
    private static Object activityService()throws Exception{return ActivityManager.class.getMethod("getService").invoke(null);}
    private static Configuration configuration()throws Exception {Object s=activityService();return (Configuration)Class.forName("android.app.IActivityManager").getMethod("getConfiguration").invoke(s);}
    private static void updateConfiguration(Configuration c)throws Exception {Class.forName("android.app.IActivityManager").getMethod("updatePersistentConfiguration",Configuration.class).invoke(activityService(),c);}
    private static Object notificationService()throws Exception {IBinder b=(IBinder)Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"notification");return Class.forName("android.app.INotificationManager$Stub").getMethod("asInterface",IBinder.class).invoke(null,b);}
    private static void shell(String command)throws Exception {java.lang.Process p=new ProcessBuilder("/system/bin/sh","-c",command).redirectErrorStream(true).start();if(!p.waitFor(10,TimeUnit.SECONDS)){p.destroy();throw new IOException("系统命令超时");}if(p.exitValue()!=0)throw new IOException("系统命令未成功");}
}
