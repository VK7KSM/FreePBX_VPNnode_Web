package org.onetwoone.gateway.remote;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * 2026-09-19 生产事故的回归测试：面板上 Pixel 网关变成「报告超时」、所有按钮变灰。
 *
 * <p>真机线程栈里是一对互指的 Blocked：会话线程在 finish() 里持有会话锁、等 WebSocketImpl 的锁；
 * WebSocket 读线程在 onClose 里持有 WebSocketImpl 的锁、等会话锁。两边锁顺序相反，抱死。
 * 而上报线程调的 accept() 当时也是 synchronized 的，于是跟着一起卡死，
 * 一个远程桌面的缺陷升级成整台设备失联。
 *
 * <p>这里不依赖 Android，只复刻那个锁顺序：验证「关闭动作放在锁外」之后两边不会抱死。
 */
public class DesktopCloseLockOrderTest {

    /** 复刻 WebSocket 那一侧：关闭时持有自己的锁，再回调上层。 */
    private static final class Peer {
        private final Object monitor=new Object();
        private Runnable onClose=()->{};
        void closeFromOwner(){synchronized(monitor){/* 仅占住锁 */}}
        void closeFromReader(){synchronized(monitor){onClose.run();}}
    }

    /** 复刻会话：先在锁内取走引用并置空，关闭动作在锁外做。 */
    private static final class Session {
        private final Peer peer;private boolean closed;
        Session(Peer peer){this.peer=peer;}
        void finish(){
            boolean first;
            synchronized(this){if(closed)return;closed=true;first=true;}
            if(first)peer.closeFromOwner();          // 关键：在锁外
        }
        synchronized boolean closed(){return closed;}
    }

    @Test public void closingOutsideTheLockCannotDeadlock() throws Exception {
        for(int round=0;round<200;round++){
            Peer peer=new Peer();
            Session session=new Session(peer);
            peer.onClose=session::finish;
            CountDownLatch start=new CountDownLatch(1),done=new CountDownLatch(2);
            Thread owner=new Thread(()->{await(start);session.finish();done.countDown();},"owner");
            Thread reader=new Thread(()->{await(start);peer.closeFromReader();done.countDown();},"reader");
            owner.setDaemon(true);reader.setDaemon(true);owner.start();reader.start();
            start.countDown();
            assertTrue("第 "+round+" 轮抱死了：关闭动作又跑回锁里去了",done.await(5,TimeUnit.SECONDS));
            assertTrue(session.closed());
        }
    }

    /** finish 重入必须是幂等的：读线程与会话线程可能同时进来，只有一方真正执行关闭。 */
    @Test public void finishIsIdempotentUnderConcurrency() throws Exception {
        Peer peer=new Peer();
        Session session=new Session(peer);
        Thread[] threads=new Thread[8];
        CountDownLatch start=new CountDownLatch(1);
        for(int i=0;i<threads.length;i++){
            threads[i]=new Thread(()->{await(start);session.finish();});
            threads[i].setDaemon(true);threads[i].start();
        }
        start.countDown();
        for(Thread t:threads){t.join(5000);assertFalse("finish 卡住了",t.isAlive());}
        assertTrue(session.closed());
    }

    private static void await(CountDownLatch latch){
        try{latch.await();}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
    }
}
