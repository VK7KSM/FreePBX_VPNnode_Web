package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

final class RescueJobs {
    interface Runner { JSONObject run(File folder, String command, int timeout) throws Exception; }
    private final File root;
    private final Runner runner;
    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile Exception persistenceFailure;

    RescueJobs(File root, Runner runner) throws Exception {
        this.root = root;
        this.runner = runner;
        if (!root.isDirectory() && !root.mkdirs()) throw new java.io.IOException("Job directory");
        File[] dirs = root.listFiles();
        if (dirs != null) for (File dir : dirs) {
            File state = new File(dir, "result.json");
            if (!state.isFile() && dir.isDirectory()) {
                RescueFiles.write(state, new JSONObject().put("id",dir.getName()).put("state","interrupted")
                        .put("error","任务提交被中断，不自动重放").toString());
            }
            if (state.isFile()) {
                try {
                JSONObject obj = new JSONObject(RescueFiles.read(state, 600000));
                if ("running".equals(obj.optString("state"))) {
                    JSONObject recovered=SipAccountManager.recover(dir);
                    if(recovered==null)recovered=ZelloAccountManager.recover(dir);
                    if(recovered==null)recovered=FileCommit.recover(dir);
                    if(recovered==null)recovered=FileSnapshot.recover(dir);
                    if(recovered!=null){recovered.put("id",dir.getName());RescueFiles.write(state,recovered.toString());continue;}
                    obj.put("state", "interrupted").put("error", "救援进程已重启，任务不会自动重放");
                    RescueFiles.write(state, obj.toString());
                }
                } catch (Exception corrupt) {
                    RescueFiles.write(state, new JSONObject().put("id", dir.getName())
                            .put("state", "interrupted").put("error", "任务记录损坏，不自动重放").toString());
                }
            }
        }
    }

    static void validate(String id, String command, int timeout) {
        if (!id.matches("[a-zA-Z0-9-]{1,64}")) throw new IllegalArgumentException("Invalid id");
        if (command.trim().isEmpty() || command.indexOf('\0') >= 0
                || command.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 8192)
            throw new IllegalArgumentException("Command must be 1..8192 bytes");
        if (timeout < 1 || timeout > 120) throw new IllegalArgumentException("Timeout must be 1..120 seconds");
    }

    synchronized JSONObject submit(String id, String command, int timeout) throws Exception {
        return submit(id,command,timeout,runner);
    }

    synchronized JSONObject submitFile(String id, JSONObject params) throws Exception {
        // 固定键序确保回执丢失后的同号重试仍然幂等。
        JSONObject p=new JSONObject().put("source",params.getString("source")).put("path",params.getString("path"))
                .put("size",params.getLong("size")).put("sha256",params.getString("sha256")).put("overwrite",params.optBoolean("overwrite"));
        return submit(id,"file-commit:"+p.toString(),120,(folder,command,timeout)->FileCommit.run(folder,p));
    }
    synchronized JSONObject submitSnapshot(String id,JSONObject params)throws Exception{
        JSONObject p=new JSONObject().put("source",params.getString("source")).put("target",params.getString("target")).put("uid",params.getInt("uid"));
        return submit(id,"file-snapshot:"+p.toString(),120,(folder,command,timeout)->FileSnapshot.run(folder,p));
    }

    synchronized JSONObject submitFileOperation(String id,JSONObject params)throws Exception {
        JSONObject p=FileOperations.normalize(params);
        return submit(id,"file-manage:"+p.toString(),120,(folder,command,timeout)->FileOperations.run(folder,p));
    }

    synchronized JSONObject submitSipAccount(String id,JSONObject params)throws Exception {
        JSONObject p=SipAccountConfig.normalize(params);
        String fingerprint=UpdatePolicy.sha256Hex(p.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return submit(id,"configure-sip:"+fingerprint,120,(folder,command,timeout)->SipAccountManager.apply(folder,p));
    }

    synchronized JSONObject submitZelloAccount(String id,JSONObject params)throws Exception {
        JSONObject p=ZelloAccountConfig.normalize(params);
        String fingerprint=UpdatePolicy.sha256Hex(p.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return submit(id,"configure-zello:"+fingerprint,120,(folder,command,timeout)->ZelloAccountManager.apply(folder,p));
    }

    private JSONObject submit(String id, String command, int timeout, Runner execution) throws Exception {
        if (persistenceFailure != null) throw new IOException("任务结果持久化失败，停止接受新任务", persistenceFailure);
        validate(id, command, timeout);
        if (new File(root.getParentFile(),"upgrading").exists()) throw new IllegalStateException("维护核心正在更新");
        File folder = new File(root, id);
        if (folder.exists()) {
            JSONObject old = new JSONObject(RescueFiles.read(new File(folder, "request.json"), 60000));
            if (!command.equals(old.getString("command")) || timeout != old.getInt("timeout"))
                throw new IllegalStateException("Request id already used with different command");
            return get(id);
        }
        if (!busy.compareAndSet(false, true)) throw new IllegalStateException("A command is already running");
        try {
            prune();
            if (!folder.mkdir()) throw new java.io.IOException("Create job failed");
            RescueFiles.write(new File(folder, "request.json"), new JSONObject()
                    .put("command", command).put("timeout", timeout).toString());
            JSONObject state = new JSONObject().put("id", id).put("state", "running")
                    .put("started", System.currentTimeMillis());
            RescueFiles.write(new File(folder, "result.json"), state.toString());
            JSONObject accepted = new JSONObject(state.toString());
            new Thread(() -> {
                try {
                    JSONObject result = execution.run(folder, command, timeout);
                    for (java.util.Iterator<String> it = result.keys(); it.hasNext();) {
                        String key = it.next(); state.put(key, result.get(key));
                    }
                } catch (Exception error) {
                    try { state.put("state", "failed").put("error", error.toString()); }
                    catch (Exception ignored) { }
                } finally {
                    try {
                        state.put("finished", System.currentTimeMillis());
                        RescueFiles.write(new File(folder, "result.json"), state.toString());
                    } catch (Exception failure) { persistenceFailure = failure; failure.printStackTrace(); }
                    busy.set(false);
                }
            }, "elfremote-rescue-command").start();
            return accepted;
        } catch (Exception error) {
            busy.set(false);
            throw error;
        }
    }

    JSONObject get(String id) throws Exception {
        if (persistenceFailure != null) throw new IOException("任务结果未可靠保存", persistenceFailure);
        if (!id.matches("[a-zA-Z0-9-]{1,64}")) throw new IllegalArgumentException("Invalid id");
        File file = new File(new File(root, id), "result.json");
        return file.isFile() ? new JSONObject(RescueFiles.read(file, 600000)) : null;
    }

    synchronized JSONObject upgrade(boolean prepare) throws Exception {
        File marker = new File(root.getParentFile(), "upgrading");
        if (prepare) RescueFiles.write(marker, "upgrading\n");
        else if (marker.exists() && !marker.delete()) throw new IOException("解除核心更新门失败");
        return new JSONObject().put("busy", busy.get());
    }

    boolean isBusy() { return busy.get(); }

    JSONObject fileHistory() throws Exception {
        org.json.JSONArray files=new org.json.JSONArray();
        File[] dirs=root.listFiles(File::isDirectory);
        if(dirs!=null)for(File dir:dirs)try{
            JSONObject request=new JSONObject(RescueFiles.read(new File(dir,"request.json"),60000));
            String command=request.optString("command");if(!command.startsWith("file-commit:"))continue;
            JSONObject p=new JSONObject(command.substring(12)),r=get(dir.getName());if(r==null)continue;
            boolean ok="committed".equals(r.optString("action"));
            files.put(new JSONObject().put("id",dir.getName()).put("path",p.getString("path")).put("bytes",p.getLong("size"))
                    .put("state",ok?"success":r.optString("state")).put("detail",ok?"文件已保存":"running".equals(r.optString("state"))?"正在保存文件":"文件未保存")
                    .put("at",r.optLong("finished",r.optLong("started",dir.lastModified()))));
        }catch(Exception ignored){}
        return new JSONObject().put("files",files);
    }

    synchronized JSONObject cancel(String id) throws Exception {
        JSONObject state=get(id);
        if (state!=null && "running".equals(state.optString("state")))
            RescueFiles.write(new File(new File(root,id),"cancel"),"cancel\n");
        return state;
    }

    private void prune() {
        File[] dirs = root.listFiles(File::isDirectory);
        if (dirs == null) return;
        long cutoff=System.currentTimeMillis()-30L*24*60*60*1000;
        for (File dir : dirs) {
            try {
                JSONObject result=get(dir.getName());
                if(result==null||"running".equals(result.optString("state")))continue;
                long finished=result.optLong("finished",new File(dir,"result.json").lastModified());
                if(finished<=0||finished>=cutoff)continue;
                File[] files=dir.listFiles();
                if(files!=null)for(File file:files)if(file.isFile())file.delete();
                dir.delete();
            } catch(Exception unreadable) { /* 无法核对的记录保留，不按数量删除去重依据。 */ }
        }
    }
}
