package net.elfradio.elfremote;

import org.json.JSONObject;

/** 每一步可在进程中断后继续；原凭据只在完整核验后删除。 */
final class LostRecovery {
    interface Control {
        boolean secure()throws Exception;
        boolean verify(String password)throws Exception;
        void password(String value,String old)throws Exception;
        boolean locked()throws Exception;
        void dismiss()throws Exception;
        void disabled(boolean value)throws Exception;
        void owner(JSONObject value)throws Exception;
        void decryptSetting(String value)throws Exception;
    }
    interface Save {void save()throws Exception;}
    static void restore(JSONObject s,Control system,Save save)throws Exception {
        if(!s.has("original_owner"))return;
        String phase=s.optString("restore_phase","clear"),original=s.optString("original_credential");
        if(phase.equals("clear")){
            if(system.secure()){
                String current=s.optString("credential"),previous=s.optString("pending_old_credential");
                if(!system.verify(current)){
                    if(previous.isEmpty()||!system.verify(previous))throw new IllegalStateException("lost-current-password-changed");
                    current=previous;
                }
                system.password("",current);
            }
            s.put("restore_phase","dismiss");save.save();phase="dismiss";
        }
        if(phase.equals("dismiss")){
            if(system.secure())throw new IllegalStateException("lost-current-password-changed");
            system.disabled(true);system.dismiss();
            s.put("restore_phase","original");save.save();phase="original";
        }
        if(phase.equals("original")){
            if(s.optBoolean("original_secure")){
                if(!system.secure())system.password(original,"");
                if(!system.verify(original))throw new IllegalStateException("lost-original-password-pending");
            }else if(system.secure())throw new IllegalStateException("lost-current-password-changed");
            s.put("restore_phase","settings");save.save();phase="settings";
        }
        if(!phase.equals("settings"))throw new IllegalStateException("lost-restore-state-invalid");
        if(system.secure()!=s.optBoolean("original_secure")||(system.secure()&&!system.verify(original)))
            throw new IllegalStateException("lost-original-password-pending");
        system.owner(s.getJSONObject("original_owner"));
        system.disabled(s.optBoolean("original_lock_disabled"));
        system.decryptSetting(s.has("original_decrypt_setting")?s.getString("original_decrypt_setting"):null);
        if(!system.secure()&&system.locked())system.dismiss();
        // 恢复原密码后可被系统重新锁定，不清除原密码来伪造未锁定。
        s.put("restored",true);
    }
    private LostRecovery(){}
}
