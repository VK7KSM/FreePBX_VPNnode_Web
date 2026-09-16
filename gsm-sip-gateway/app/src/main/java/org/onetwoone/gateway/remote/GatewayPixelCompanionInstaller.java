package org.onetwoone.gateway.remote;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Builds and atomically installs the disabled-by-default Pixel root companion. */
final class GatewayPixelCompanionInstaller {
    static final String MODULE_ID="elfremote_gateway_companion";
    private static final String PREFIX="unified/";
    private static final String FINGERPRINT="google/crosshatch/crosshatch:12/SP1A.210812.016.B2/8602260:user/release-keys";
    private static final String RECEIPT=".elfremote-manifest.json";
    private static final String ABSENT_ROLLBACK="."+MODULE_ID+".rollback-absent.json";

    interface Source { InputStream open(String path) throws Exception; }
    interface Hook { void afterBackup() throws Exception; }

    static JSONObject install(File modulesRoot,InputStream manifestInput,Source source,
                              String device,String fingerprint) throws Exception {
        return install(modulesRoot,manifestInput,source,device,fingerprint,null,()->{});
    }

    static JSONObject install(File modulesRoot,InputStream manifestInput,Source source,
                              String device,String fingerprint,File configFile) throws Exception {
        return install(modulesRoot,manifestInput,source,device,fingerprint,configFile,()->{});
    }

    static JSONObject install(File modulesRoot,InputStream manifestInput,Source source,
                              String device,String fingerprint,Hook hook) throws Exception {
        return install(modulesRoot,manifestInput,source,device,fingerprint,null,hook);
    }

    static JSONObject install(File modulesRoot,InputStream manifestInput,Source source,
                              String device,String fingerprint,File configFile,Hook hook) throws Exception {
        if(!"crosshatch".equals(device)||!FINGERPRINT.equals(fingerprint))
            throw new SecurityException("unsupported Pixel build");
        if(Files.isSymbolicLink(modulesRoot.toPath())||(!modulesRoot.isDirectory()&&!modulesRoot.mkdirs()))
            throw new IOException("module root unavailable");
        JSONObject manifest=new JSONObject(read(manifestInput,65536));
        validateIdentity(manifest);
        JSONArray all=manifest.getJSONArray("files"),selected=new JSONArray();
        for(int i=0;i<all.length();i++) {
            JSONObject entry=all.getJSONObject(i);String path=entry.getString("path");
            if(path.startsWith(PREFIX))selected.put(new JSONObject(entry.toString()));
        }
        if(selected.length()<6||selected.length()>16)throw new SecurityException("unified payload incomplete");
        rejectUnknownLegacy(modulesRoot);

        File target=new File(modulesRoot,MODULE_ID),stage=new File(modulesRoot,"."+MODULE_ID+".stage"),
                backup=new File(modulesRoot,"."+MODULE_ID+".rollback"),absentRollback=new File(modulesRoot,ABSENT_ROLLBACK);
        if(stage.exists())removeOwned(stage);
        if(backup.exists())throw new IOException("previous rollback retained");
        if(absentRollback.exists()&&(!target.isDirectory()||!validAbsentRollback(absentRollback,target)))
            throw new SecurityException("unrecognized absent rollback state");
        if(target.exists()&&!trustedInstalled(target))throw new SecurityException("unrecognized companion conflict");
        if(target.isDirectory()&&matches(target,selected)) {
            if(!absentRollback.exists())writeAbsentRollback(absentRollback,target);
            return result("unchanged",false,modulesRoot,configFile);
        }

        if(!stage.mkdir())throw new IOException("staging create failed");
        boolean movedOld=false,committed=false;
        try {
            for(int i=0;i<selected.length();i++)copyEntry(stage,selected.getJSONObject(i),source);
            writeReceipt(stage,selected);
            if(!matches(stage,selected))throw new SecurityException("staging verification failed");
            if(target.exists()) {
                if(!target.renameTo(backup))throw new IOException("companion backup failed");
                movedOld=true;
            }
            hook.afterBackup();
            if(!stage.renameTo(target))throw new IOException("companion commit failed");
            committed=true;
            if(!matches(target,selected))throw new SecurityException("installed verification failed");
            if(!movedOld)writeAbsentRollback(absentRollback,target);
            JSONObject result=result(movedOld?"upgraded":"installed",movedOld,modulesRoot,configFile);
            if(movedOld&&absentRollback.exists()&&!absentRollback.delete())throw new IOException("absent rollback cleanup failed");
            return result;
        } catch(Exception failure) {
            if(committed&&target.exists()) {
                if(!trustedInstalled(target))throw new SecurityException("failed companion became untrusted",failure);
                removeOwned(target);
            }
            if(!target.exists()&&movedOld&&!backup.renameTo(target))
                throw new IOException("companion rollback failed",failure);
            if(!movedOld&&absentRollback.exists()&&!absentRollback.delete())
                throw new IOException("absent rollback cleanup failed",failure);
            throw failure;
        } finally {
            if(stage.exists())removeOwned(stage);
        }
    }

    static JSONObject rollback(File modulesRoot) throws Exception {
        File target=new File(modulesRoot,MODULE_ID),backup=new File(modulesRoot,"."+MODULE_ID+".rollback"),
                failed=new File(modulesRoot,"."+MODULE_ID+".failed"),absentRollback=new File(modulesRoot,ABSENT_ROLLBACK);
        boolean previous=backup.isDirectory()&&trustedInstalled(backup),absent=validAbsentRollback(absentRollback,target);
        if(!previous&&!absent)throw new IOException("trusted rollback unavailable");
        if(failed.exists())throw new IOException("failed version retained");
        if(target.exists()) {
            if(!trustedInstalled(target))throw new SecurityException("current companion unrecognized");
            if(!target.renameTo(failed))throw new IOException("current companion preserve failed");
        }
        if(absent) {
            if(!absentRollback.delete()) {
                if(failed.exists())failed.renameTo(target);
                throw new IOException("absent rollback commit failed");
            }
            return result("rolled_back_absent",false,modulesRoot,null);
        }
        if(!backup.renameTo(target)) {
            if(failed.exists())failed.renameTo(target);
            throw new IOException("rollback commit failed");
        }
        return result("rolled_back",false,modulesRoot,null);
    }

    static JSONObject inspect(File modulesRoot,File configFile) throws Exception {
        File module=new File(modulesRoot,MODULE_ID),backup=new File(modulesRoot,"."+MODULE_ID+".rollback");
        boolean installed=module.isDirectory(),recognized=false,rollback=false;
        try{recognized=installed&&trustedInstalled(module);}catch(Exception ignored){}
        try{rollback=backup.isDirectory()&&trustedInstalled(backup);}catch(Exception ignored){}
        try{rollback=rollback||validAbsentRollback(new File(modulesRoot,ABSENT_ROLLBACK),module);}catch(Exception ignored){}
        JSONObject units=new JSONObject().put("charge",false).put("audio",false).put("adb_tcp",false);
        String version="";
        if(recognized) {
            version=property(new File(module,"module.prop"),"version",64);
            File effective=configFile!=null&&configFile.isFile()?configFile:new File(module,"default.conf");
            Map<String,String> config=properties(effective,4096);
            units.put("charge","1".equals(config.get("CHARGE_ENABLED")))
                    .put("audio","1".equals(config.get("AUDIO_ENABLED")))
                    .put("adb_tcp","1".equals(config.get("ADB_TCP_ENABLED")));
        }
        boolean active=recognized&&!new File(module,"disable").isFile()
                &&(units.getBoolean("charge")||units.getBoolean("audio")||units.getBoolean("adb_tcp"));
        JSONObject result=new JSONObject().put("installed",installed).put("disabled",new File(module,"disable").isFile())
                .put("recognized",recognized).put("active",active).put("rollback_available",rollback).put("units",units);
        if(!version.isEmpty())result.put("version",version);
        return result;
    }

    private static void validateIdentity(JSONObject manifest) throws Exception {
        if(manifest.optInt("schema_version")!=1||!"elfremote_gateway".equals(manifest.optString("product"))
                ||!"crosshatch".equals(manifest.optString("device")))
            throw new SecurityException("pixel asset manifest identity invalid");
    }

    private static void rejectUnknownLegacy(File root) throws Exception {
        JSONObject legacy=GatewayPixelLegacyHealth.snapshot(root);
        for(String key:new String[]{"charge_bypass","sip_audio_access"}) {
            JSONObject module=legacy.getJSONObject(key);
            if(module.getBoolean("installed")&&!module.getBoolean("recognized"))
                throw new SecurityException("unrecognized legacy module conflict");
        }
    }

    private static String legacyMode(File root) throws Exception {
        JSONObject legacy=GatewayPixelLegacyHealth.snapshot(root);
        boolean charge=legacy.getJSONObject("charge_bypass").getBoolean("installed");
        boolean audio=legacy.getJSONObject("sip_audio_access").getBoolean("installed");
        if(charge&&audio)return "preserved";
        if(charge||audio)return "partial";
        return "absent";
    }

    private static void copyEntry(File stage,JSONObject entry,Source source) throws Exception {
        String path=entry.getString("path");
        if(!path.startsWith(PREFIX))throw new SecurityException("invalid unified path");
        String relative=path.substring(PREFIX.length());
        if(!relative.matches("[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+){0,3}")||relative.contains(".."))
            throw new SecurityException("invalid unified path");
        long size=entry.optLong("size",-1);String hash=entry.optString("sha256");
        if(size<1||size>65536||!hash.matches("[0-9a-f]{64}"))throw new SecurityException("invalid unified metadata");
        File destination=new File(stage,relative).getCanonicalFile();
        if(!destination.getPath().startsWith(stage.getCanonicalPath()+File.separator))throw new SecurityException("path escaped");
        File parent=destination.getParentFile();if(!parent.isDirectory()&&!parent.mkdirs())throw new IOException("staging directory failed");
        byte[] body;try(InputStream input=source.open(path)){body=readBytes(input,65536);}
        if(body.length!=size||!hash.equals(sha256(body)))throw new SecurityException("unified asset integrity mismatch");
        try(FileOutputStream output=new FileOutputStream(destination)){output.write(body);output.getFD().sync();}
        boolean script=relative.endsWith(".sh");
        if(!destination.setReadable(true,true)||!destination.setWritable(true,true)||(script&&!destination.setExecutable(true,false)))
            throw new IOException("payload mode failed");
    }

    private static boolean trustedInstalled(File directory) throws Exception {
        File receipt=new File(directory,RECEIPT);if(!directory.isDirectory()||!receipt.isFile())return false;
        JSONObject value=new JSONObject(read(new FileInputStream(receipt),65536));
        if(!MODULE_ID.equals(value.optString("module_id"))||!moduleId(directory))return false;
        return matches(directory,value.optJSONArray("files"));
    }

    private static boolean moduleId(File directory) throws Exception {
        return MODULE_ID.equals(property(new File(directory,"module.prop"),"id",64));
    }

    private static String property(File file,String wanted,int maximum) throws Exception {
        String value=properties(file,4096).getOrDefault(wanted,"");
        return value.substring(0,Math.min(maximum,value.length()));
    }
    private static Map<String,String> properties(File file,int maximum) throws Exception {
        if(!file.isFile()||file.length()<1||file.length()>maximum)throw new IOException("property file invalid");
        Map<String,String> result=new LinkedHashMap<>();
        try(BufferedReader reader=new BufferedReader(new InputStreamReader(new FileInputStream(file),StandardCharsets.UTF_8))) {
            for(String line;(line=reader.readLine())!=null;) {
                int split=line.indexOf('=');if(split<=0)continue;
                String key=line.substring(0,split).trim(),value=line.substring(split+1).trim();
                if(key.matches("[A-Za-z0-9_.-]{1,64}")&&value.length()<=256)result.put(key,value);
            }
        }
        return result;
    }

    private static boolean matches(File directory,JSONArray files) throws Exception {
        if(files==null||files.length()<6||files.length()>16||Files.isSymbolicLink(directory.toPath()))return false;
        Set<String> seen=new HashSet<>();
        for(int i=0;i<files.length();i++) {
            JSONObject entry=files.getJSONObject(i);String path=entry.getString("path");
            String relative=path.startsWith(PREFIX)?path.substring(PREFIX.length()):path;
            if(!relative.matches("[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+){0,3}")||relative.contains("..")||!seen.add(relative))return false;
            File file=new File(directory,relative);
            if(!file.isFile()||Files.isSymbolicLink(file.toPath())||file.length()!=entry.getLong("size")
                    ||!entry.getString("sha256").equals(sha256(file)))return false;
        }
        return true;
    }

    private static void writeReceipt(File stage,JSONArray selected) throws Exception {
        JSONArray files=new JSONArray();
        for(int i=0;i<selected.length();i++) {
            JSONObject input=selected.getJSONObject(i);
            files.put(new JSONObject().put("path",input.getString("path").substring(PREFIX.length()))
                    .put("size",input.getLong("size")).put("sha256",input.getString("sha256")));
        }
        byte[] body=new JSONObject().put("schema_version",1).put("module_id",MODULE_ID)
                .put("files",files).toString().getBytes(StandardCharsets.UTF_8);
        try(FileOutputStream output=new FileOutputStream(new File(stage,RECEIPT))){output.write(body);output.getFD().sync();}
    }

    private static JSONObject result(String state,boolean upgraded,File modulesRoot,File configFile) throws Exception {
        JSONObject companion=inspect(modulesRoot,configFile),all=GatewayPixelLegacyHealth.snapshot(modulesRoot);
        JSONObject units=companion.getJSONObject("units"),charge=legacyPublic(all.getJSONObject("charge_bypass")),audio=legacyPublic(all.getJSONObject("sip_audio_access"));
        String legacy=charge.getBoolean("installed")&&audio.getBoolean("installed")?"preserved":charge.getBoolean("installed")||audio.getBoolean("installed")?"partial":"absent";
        return new JSONObject().put("state",state).put("module_id",MODULE_ID).put("units_enabled",companion.getBoolean("active"))
                .put("upgraded",upgraded).put("rollback_available",companion.getBoolean("rollback_available")).put("legacy_modules",legacy)
                .put("units",units).put("legacy",new JSONObject().put("charge_bypass",charge).put("sip_audio_access",audio));
    }

    private static JSONObject legacyPublic(JSONObject value) throws Exception {
        return new JSONObject().put("installed",value.getBoolean("installed")).put("disabled",value.getBoolean("disabled"))
                .put("recognized",value.getBoolean("recognized"));
    }

    private static void writeAbsentRollback(File marker,File target) throws Exception {
        if(!trustedInstalled(target))throw new SecurityException("untrusted absent rollback target");
        File receipt=new File(target,RECEIPT),next=new File(marker.getPath()+".new");
        JSONObject value=new JSONObject().put("schema_version",1).put("module_id",MODULE_ID).put("restore","absent")
                .put("receipt_sha256",sha256(receipt));
        try(FileOutputStream output=new FileOutputStream(next)){output.write(value.toString().getBytes(StandardCharsets.UTF_8));output.getFD().sync();}
        if(!next.setReadable(true,true)||!next.setWritable(true,true))throw new IOException("absent rollback mode failed");
        if(marker.exists()&&!marker.delete())throw new IOException("absent rollback replacement failed");
        if(!next.renameTo(marker))throw new IOException("absent rollback commit failed");
    }

    private static boolean validAbsentRollback(File marker,File target) throws Exception {
        if(!marker.isFile()||Files.isSymbolicLink(marker.toPath())||!target.isDirectory()||!trustedInstalled(target))return false;
        JSONObject value=new JSONObject(read(new FileInputStream(marker),4096));
        return value.length()==4&&value.optInt("schema_version")==1&&MODULE_ID.equals(value.optString("module_id"))
                &&"absent".equals(value.optString("restore"))&&sha256(new File(target,RECEIPT)).equals(value.optString("receipt_sha256"));
    }

    private static void removeOwned(File value) throws Exception {
        if(Files.isSymbolicLink(value.toPath()))throw new SecurityException("symbolic module path");
        File[] children=value.listFiles();if(children!=null)for(File child:children)removeOwned(child);
        if(!value.delete())throw new IOException("owned cleanup failed");
    }

    private static String read(InputStream input,int maximum) throws Exception {
        return new String(readBytes(input,maximum),StandardCharsets.UTF_8);
    }
    private static byte[] readBytes(InputStream input,int maximum) throws Exception {
        try(InputStream source=input;ByteArrayOutputStream output=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[4096];for(int read;(read=source.read(buffer))!=-1;){output.write(buffer,0,read);if(output.size()>maximum)throw new IOException("asset too large");}
            return output.toByteArray();
        }
    }
    private static String sha256(byte[] body) throws Exception {return hex(MessageDigest.getInstance("SHA-256").digest(body));}
    private static String sha256(File file) throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[4096];for(int read;(read=input.read(buffer))!=-1;)digest.update(buffer,0,read);}return hex(digest.digest());
    }
    private static String hex(byte[] bytes){StringBuilder text=new StringBuilder();for(byte value:bytes)text.append(String.format(Locale.ROOT,"%02x",value&255));return text.toString();}
    private GatewayPixelCompanionInstaller() {}
}
