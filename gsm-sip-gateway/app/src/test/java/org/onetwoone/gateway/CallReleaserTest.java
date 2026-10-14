package org.onetwoone.gateway;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/**
 * 2026-10-14 14:02 回归：上一通电话的 pjsua2 对象被留给垃圾回收，回收线程未在 pjlib 登记，
 * 而且它的通话编号已被下一通电话复用，析构时去挂断那通正在进行的电话，整个网关因断言中止。
 * 现在每个通话对象从创建起就被强引用，垃圾回收永远不会析构它；只由主线程在断开后主动释放，
 * 编号已被复用时宁可把对象留住，也不去碰新通话。
 */
@RunWith(RobolectricTestRunner.class)
@Config(manifest=Config.NONE,sdk=28)
public class CallReleaserTest {
    private static final class Fake implements CallReleaser.Target {
        boolean inUse, throwOnFree; int frees;
        @Override public boolean idInUse() { return inUse; }
        @Override public void free() throws Exception { if (throwOnFree) throw new Exception("boom"); frees++; }
    }

    @Test public void untrackedObjectIsNeverTouched() {
        Fake f = new Fake();
        assertEquals("already", CallReleaser.release(f, new Object()));
        assertEquals(0, f.frees);
    }

    @Test public void finishedCallIsFreedExactlyOnceAndDropped() {
        Fake f = new Fake(); Object owner = new Object(); CallReleaser.track(owner);
        assertTrue(CallReleaser.isTracked(owner));
        assertEquals("released", CallReleaser.release(f, owner));
        assertFalse("释放后不再持有", CallReleaser.isTracked(owner));
        assertEquals("already", CallReleaser.release(f, owner));
        assertEquals(1, f.frees);
    }

    @Test public void reusedIdIsNeverFreedAndKeptAlive() {
        Fake f = new Fake(); f.inUse = true; Object owner = new Object(); CallReleaser.track(owner);
        assertEquals("parked", CallReleaser.release(f, owner));
        assertEquals(0, f.frees);
        assertTrue("仍被强引用，垃圾回收永远不会去析构它", CallReleaser.isTracked(owner));
    }

    @Test public void failedFreeIsParkedNotRetriedByFinalizer() {
        Fake f = new Fake(); f.throwOnFree = true; Object owner = new Object(); CallReleaser.track(owner);
        assertEquals("parked", CallReleaser.release(f, owner));
        assertTrue(CallReleaser.isTracked(owner));
    }

    @Test public void unreadableStateCountsAsInUse() {
        Object owner = new Object(); CallReleaser.track(owner);
        CallReleaser.Target broken = new CallReleaser.Target() {
            @Override public boolean idInUse() throws Exception { throw new Exception("call gone"); }
            @Override public void free() { fail("不能释放状态不明的对象"); }
        };
        assertEquals("parked", CallReleaser.release(broken, owner));
    }
}
