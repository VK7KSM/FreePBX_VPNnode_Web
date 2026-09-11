package net.elfradio.elfremote;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class FileTransferStatusTest {
    private JSONObject row(String direction,String state,long at)throws Exception{
        return new JSONObject().put("direction",direction).put("state",state).put("at",at)
                .put("path","/sdcard/Download/example.txt").put("expires_at",100000).put("percent",42);
    }
    @Test public void showsBothDirectionsWithMeasuredProgress()throws Exception{
        JSONArray rows=new JSONArray().put(row("send","running",100)).put(row("receive","running",200));
        assertEquals("正在接收 42% · example.txt\n正在发送 42% · example.txt",FileTransferStatus.text(rows,300));
    }
    @Test public void completionExpiresAndDoesNotResurrectOldTask()throws Exception{
        JSONArray rows=new JSONArray().put(row("receive","running",100)).put(row("receive","success",200));
        assertEquals("接收完成 · example.txt",FileTransferStatus.text(rows,30199));
        assertEquals("",FileTransferStatus.text(rows,30200));
    }
    @Test public void ignoresOldInboxHistoryAndExpiredOrFutureStates()throws Exception{
        JSONArray rows=new JSONArray().put(new JSONObject().put("detail","文件已保存").put("at",200));
        assertEquals("",FileTransferStatus.text(rows,300));
        rows.put(row("receive","running",400));
        assertEquals("",FileTransferStatus.text(rows,300));
        assertEquals("",FileTransferStatus.text(rows,100000));
    }
    @Test public void showsPauseRetryPreparationAndFailureWithoutFakeProgress()throws Exception{
        JSONObject r=row("send","claimed",100);JSONArray rows=new JSONArray().put(r);
        assertEquals("正在准备发送 · example.txt",FileTransferStatus.text(rows,200));
        r.put("state","running").put("detail","已暂停，等待网络");
        assertEquals("发送已暂停，等待联网 · example.txt",FileTransferStatus.text(rows,200));
        r.put("detail","取回中断，稍后继续");
        assertEquals("发送中断，等待重试 · example.txt",FileTransferStatus.text(rows,200));
        r.put("state","failed");assertEquals("发送失败 · example.txt",FileTransferStatus.text(rows,200));
        r.put("detail","文件取回已停止");assertEquals("发送已停止 · example.txt",FileTransferStatus.text(rows,200));
    }
    @Test public void receiveWaitsForCommitAndSendDoesNotClaimComputerSaved()throws Exception{
        JSONObject r=row("receive","running",100).put("detail","接收完成，正在校验并保存文件");
        assertEquals("正在校验并保存 · example.txt",FileTransferStatus.text(new JSONArray().put(r),200));
        r.put("direction","send").put("state","success");
        assertEquals("发送完成 · example.txt",FileTransferStatus.text(new JSONArray().put(r),200));
    }
    @Test public void percentageHandlesUnknownEmptyAndLargeFiles(){
        assertEquals(-1,FileTransferStatus.percent(0,0));assertEquals(50,FileTransferStatus.percent(5000000000L,10000000000L));
        assertEquals(100,FileTransferStatus.percent(110,100));assertEquals(0,FileTransferStatus.percent(-1,100));
    }
}
