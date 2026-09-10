package net.elfradio.elfremote;

/** 当前已实现功能的统一权限清单；新增能力时在这里集中维护。 */
final class PermissionPolicy {
    static final String[] RUNTIME = {
        "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.CAMERA", "android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"
    };
    static String commands() {
        StringBuilder s = new StringBuilder("#!/system/bin/sh\n[ \"$(id -u)\" = 0 ] || exit 1\nfailed=0\n");
        for (String permission : RUNTIME)
            s.append("pm grant --user 0 net.elfradio.elfremote ").append(permission).append(" || failed=1\n");
        s.append("dumpsys deviceidle whitelist +net.elfradio.elfremote || failed=1\nexit $failed\n");
        return s.toString();
    }
    static synchronized org.json.JSONObject initializeFromCore() throws Exception {
        if (android.os.Process.myUid()!=0) throw new java.io.IOException("root-core-required");
        java.io.File dir=new java.io.File(CoreInstaller.DIR,"permission-initialize");
        if(!dir.isDirectory()&&!dir.mkdirs())throw new java.io.IOException("permission-stage");
        java.io.File script=new java.io.File(dir,"apply.sh");RescueFiles.write(script,commands());
        Process p=new ProcessBuilder("sh",script.getPath()).redirectErrorStream(true)
                .redirectOutput(new java.io.File(dir,"result.out")).start();
        try {
            if(!p.waitFor(25,java.util.concurrent.TimeUnit.SECONDS))throw new java.io.IOException("permission-timeout");
            if(p.exitValue()!=0)throw new java.io.IOException("permission-command-failed");
            return new org.json.JSONObject().put("ok",true);
        }finally{p.destroy();}
    }
    private PermissionPolicy() { }
}
