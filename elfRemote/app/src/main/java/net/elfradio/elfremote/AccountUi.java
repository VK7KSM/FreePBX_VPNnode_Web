package net.elfradio.elfremote;

import android.app.UiAutomation;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.IOException;

/** 仅用于官方账号登录页，不读取其他应用界面、不把密码放入命令行。 */
public final class AccountUi implements AutoCloseable {
    private final HandlerThread thread=new HandlerThread("elfremote-account-ui");
    private UiAutomation automation;
    AccountUi()throws Exception {
        thread.start();
        try {
            Class<?> connection=Class.forName("android.app.IUiAutomationConnection");
            Object binder=Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().newInstance();
            automation=(UiAutomation)UiAutomation.class.getDeclaredConstructor(Looper.class,connection).newInstance(thread.getLooper(),binder);
            // Android 7+的此标记保留其他已启用的无障碍服务。
            UiAutomation.class.getMethod("connect",int.class).invoke(automation,1);
            android.accessibilityservice.AccessibilityServiceInfo info=automation.getServiceInfo();
            info.flags|=android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            automation.setServiceInfo(info);
        }catch(Exception error){close();throw error;}
    }
    AccessibilityNodeInfo root()throws Exception {
        AccessibilityNodeInfo node=automation.getRootInActiveWindow();
        if(node==null||!"com.loudtalks".contentEquals(node.getPackageName()==null?"":node.getPackageName())) {
            if(node!=null)node.recycle();throw new IOException("Zello登录窗口不在前台");
        }return node;
    }
    static boolean setText(AccessibilityNodeInfo node,String text){Bundle bundle=new Bundle();bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,text);return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,bundle);}
    private AccessibilityNodeInfo find(AccessibilityNodeInfo node,String id,int depth){
        if(depth>30)return null;
        if(id.equals(node.getViewIdResourceName()))return AccessibilityNodeInfo.obtain(node);
        for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo c=node.getChild(i);if(c!=null)try{AccessibilityNodeInfo result=find(c,id,depth+1);if(result!=null)return result;}finally{c.recycle();}}
        return null;
    }
    boolean fill(String resourceId,String value,boolean password)throws Exception {
        AccessibilityNodeInfo root=root();try {
            AccessibilityNodeInfo container=find(root,"com.loudtalks:id/"+resourceId,0);
            if(container==null)return false;
            try{return fillEditable(container,value,password,0);}finally{container.recycle();}
        }finally{root.recycle();}
    }
    private boolean fillEditable(AccessibilityNodeInfo node,String value,boolean password,int depth)throws Exception {
        if(depth>15)return false;
        if(node.isEditable()){
            if(node.isPassword()!=password||!node.isEnabled())throw new IOException("账号输入控件类型不符");
            return setText(node,value);
        }
        for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo c=node.getChild(i);if(c!=null)try{if(fillEditable(c,value,password,depth+1))return true;}finally{c.recycle();}}
        return false;
    }
    boolean clickText(String text)throws Exception {
        AccessibilityNodeInfo root=root();try{return clickText(root,text,0);}finally{root.recycle();}
    }
    private boolean clickText(AccessibilityNodeInfo node,String text,int depth)throws Exception {
        if(depth>30)return false;
        if(!node.isEditable()&&text.contentEquals(node.getText()==null?"":node.getText())){
            AccessibilityNodeInfo current=AccessibilityNodeInfo.obtain(node);
            try{for(int i=0;i<4&&current!=null;i++){
                if(current.isClickable()&&current.isEnabled())return current.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                AccessibilityNodeInfo parent=current.getParent();current.recycle();current=parent;
            }}finally{if(current!=null)current.recycle();}
        }
        for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo c=node.getChild(i);if(c!=null)try{if(clickText(c,text,depth+1))return true;}finally{c.recycle();}}
        return false;
    }
    boolean click(String resourceId)throws Exception {
        AccessibilityNodeInfo root=root();try{return clickInTree(root,"com.loudtalks:id/"+resourceId,0);}finally{root.recycle();}
    }
    private boolean clickInTree(AccessibilityNodeInfo node,String id,int depth)throws Exception {
        if(depth>30)return false;
        if(id.equals(node.getViewIdResourceName())) {
            if(!node.isEnabled())throw new IOException("Zello登录控件当前不可用");
            if(!node.performAction(AccessibilityNodeInfo.ACTION_CLICK))throw new IOException("Zello控件拒绝无障碍点击");
            return true;
        }
        for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo child=node.getChild(i);if(child!=null)try{if(clickInTree(child,id,depth+1))return true;}finally{child.recycle();}}
        return false;
    }
    boolean has(String id)throws Exception {
        AccessibilityNodeInfo n=root();try{AccessibilityNodeInfo found=find(n,"com.loudtalks:id/"+id,0);if(found==null)return false;found.recycle();return true;}finally{n.recycle();}
    }
    boolean accountVisible(String username)throws Exception {
        AccessibilityNodeInfo n=root();try{AccessibilityNodeInfo title=find(n,"com.loudtalks:id/actionbar_one_line_title",0);
            try{return title!=null&&username.equalsIgnoreCase(String.valueOf(title.getText()))&&has("contacts_list");}finally{if(title!=null)title.recycle();}
        }finally{n.recycle();}
    }
    boolean advanceOnboarding()throws Exception {
        AccessibilityNodeInfo n=automation.getRootInActiveWindow();if(n==null)return false;
        try{
            String pkg=String.valueOf(n.getPackageName());
            if("com.android.packageinstaller".equals(pkg)){
                AccessibilityNodeInfo message=find(n,"com.android.packageinstaller:id/permission_message",0);
                String text;try{text=message==null?"":String.valueOf(message.getText());}finally{if(message!=null)message.recycle();}
                // 只处理本应用已观察到的可选权限，其他系统弹窗不盲点。
                if(text.equals("要允许Zello查找设备上的帐号吗？")||text.equals("要允许Zello读取手机状态和身份吗？"))
                    return clickInTree(n,"com.android.packageinstaller:id/permission_deny_button",0);
                return false;
            }
            if("com.android.settings".equals(pkg)){
                AccessibilityNodeInfo message=find(n,"android:id/message",0);
                String text;try{text=message==null?"":String.valueOf(message.getText());}finally{if(message!=null)message.recycle();}
                return text.startsWith("允许“Zello”始终在后台运行")&&clickInTree(n,"android:id/button1",0);
            }
            if(!"com.loudtalks".equals(pkg))return false;
            AccessibilityNodeInfo intro=find(n,"com.loudtalks:id/activity_intro_onboarding_screen",0);
            if(intro==null)return false;intro.recycle();
            return clickText("繼續")||clickText("继续")||clickText("Continue");
        }finally{n.recycle();}
    }
    @Override public void close(){if(automation!=null)try{UiAutomation.class.getMethod("disconnect").invoke(automation);}catch(Exception ignored){}thread.quitSafely();}
}
