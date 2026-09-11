package net.elfradio.elfremote;

import java.io.File;
import org.json.JSONObject;

/** 仅通过现有应用root授权调用，输入文件受应用沙箱保护，凭据不写输出。 */
public final class LostAdminMain {
    public static void main(String[] args){
        try{
            if(android.os.Process.myUid()!=0||args.length!=1)throw new SecurityException();
            File input=new File(args[0]);
            if(input.length()>16384||!input.isFile())throw new IllegalArgumentException();
            JSONObject request=new JSONObject(RescueFiles.read(input,16384));
            android.content.Context context=CoreWake.systemContext();
            // 系统凭据校验禁止在主线程执行；系统上下文初始化后转入工作线程。
            java.util.concurrent.FutureTask<JSONObject> operation=new java.util.concurrent.FutureTask<>(()->LostProtection.request(context,request));
            new Thread(operation,"elfremote-lost-admin").start();
            try{System.out.println(operation.get());}catch(java.util.concurrent.ExecutionException failure){throw failure.getCause();}
            System.exit(0);
        }catch(Throwable error){
            String code=error.getMessage();
            if(code==null||!code.matches("lost-[a-z-]{1,80}"))code="lost-system-operation-failed";
            System.out.println("{\"error\":\""+code+"\"}");System.exit(1);
        }
    }
}
