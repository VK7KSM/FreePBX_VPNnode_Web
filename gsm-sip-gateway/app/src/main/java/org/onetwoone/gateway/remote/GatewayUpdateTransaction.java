package org.onetwoone.gateway.remote;

import org.json.JSONObject;

/** Durable transitions; platform performs artifact checks and idle checks at each write. */
final class GatewayUpdateTransaction {
    interface Platform {
        JSONObject read() throws Exception;
        void write(JSONObject journal) throws Exception;
        boolean idle() throws Exception;
        boolean recoveryIdle() throws Exception;
        void backup() throws Exception;
        void installTarget() throws Exception;
        void installBackup() throws Exception;
        void startInstalled() throws Exception;
        String installedHash() throws Exception;
        boolean healthy(String hash) throws Exception;
        boolean operationSettled() throws Exception;
    }
    static String run(Platform platform,String task,String targetHash) throws Exception {
        JSONObject journal=platform.read();
        if(journal==null) {
            journal=new JSONObject().put("task",task).put("target",targetHash).put("state","prepared");
            platform.write(journal);
        }
        if(!task.equals(journal.optString("task"))||!targetHash.equals(journal.optString("target")))throw new SecurityException("transaction conflict");
        String state=journal.getString("state");
        if("success".equals(state)||"recovered".equals(state))return state;
        if("prepared".equals(state)) {
            if(!platform.idle())return "deferred";
            String original=platform.installedHash();
            platform.backup();
            journal.put("original",original);set(platform,journal,"backed_up");state="backed_up";
        }
        if("backed_up".equals(state)) {
            if(!platform.idle())return "deferred";
            if(!journal.getString("original").equals(platform.installedHash()))throw new SecurityException("installed package changed");
            set(platform,journal,"installing");
            try {platform.installTarget();} catch(Exception uncertain) {
                // Do not issue a second package operation after an uncertain install outcome.
                return "install_pending";
            }
            state="installing";
        }
        if("installing".equals(state)) {
            if(!platform.operationSettled())return "install_pending";
            String installed=platform.installedHash();
            if(targetHash.equals(installed)) {platform.startInstalled();set(platform,journal,"wait_health");state="wait_health";}
            else if(journal.getString("original").equals(installed)) {
                platform.startInstalled();
                if(!platform.healthy(installed))return "rollback_pending";
                set(platform,journal,"rollback");
                set(platform,journal,"recovered");return "recovered";
            }
            else throw new SecurityException("unexpected installed artifact");
        }
        if("wait_health".equals(state)) {
            if(platform.healthy(targetHash)) {set(platform,journal,"success");return "success";}
            if(!platform.recoveryIdle())return "recovery_deferred";
            set(platform,journal,"rollback");state="rollback";
        }
        if("rollback".equals(state)) {
            if(!platform.operationSettled())return "rollback_pending";
            if(!platform.recoveryIdle())return "recovery_deferred";
            String original=journal.getString("original");
            String installed=platform.installedHash();
            if(!original.equals(installed)) {
                if(!targetHash.equals(installed))throw new SecurityException("rollback artifact conflict");
                try {platform.installBackup();}catch(Exception uncertain){return "rollback_pending";}
            }
            if(!platform.operationSettled()||!original.equals(platform.installedHash()))return "rollback_pending";
            platform.startInstalled();
            if(!platform.healthy(original))return "rollback_pending";
            set(platform,journal,"recovered");return "recovered";
        }
        throw new SecurityException("unknown transaction state");
    }
    private static void set(Platform platform,JSONObject journal,String state) throws Exception {
        journal.put("state",state);platform.write(journal);
    }
    private GatewayUpdateTransaction(){}
}
