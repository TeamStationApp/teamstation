package app.teamstation.cameraman.eventcontrol

import android.os.SystemClock
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** What the scenarios leave to the app: a commit that throws, and the lease timer on its own. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventControlReceiverTest {
    @Test
    fun `a commit that throws is answered failed and takes no lease`() = runTest {
        val receiver = EventControlReceiver(
            instanceId = EventControlInstanceId.random(),
            credentials = EventControlFixtures.one,
            consent = true,
            apply = { _, _ -> throw IllegalStateException("disk full") }
        )
        assertEquals(EventControlAckStatus.Failed, TestDirector(receiver).take(5, "gam_demoA"))
        assertNull(receiver.overrideState)
        assertNull(receiver.leaseExpiresAt)
    }

    @Test
    fun `the lease ends on its own fifteen seconds after the last renew`() = runTest(UnconfinedTestDispatcher()) {
        val ended = ArrayList<EventOverrideEndReason>()
        val receiver = EventControlReceiver(
            instanceId = EventControlInstanceId.random(),
            credentials = EventControlFixtures.one,
            consent = true,
            apply = { _, _ -> EventControlAckStatus.Applied },
            now = { testScheduler.currentTime },
            timers = backgroundScope,
            onEvent = { if (it is EventControlReceiverEvent.OverrideEnded) ended += it.reason }
        )
        val director = TestDirector(receiver)
        assertEquals(EventControlAckStatus.Applied, director.take(5, "gam_demoA"))
        assertEquals(EventControlProtocol.LEASE_MS, receiver.leaseExpiresAt)
        advanceTimeBy(10_000)
        assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 5), director.send(EventControlBody.Renew(5)))
        advanceTimeBy(14_000)
        assertNotNull(receiver.overrideState)
        advanceTimeBy(1_001)
        assertNull(receiver.overrideState)
        assertEquals(listOf(EventOverrideEndReason.Expired), ended)
    }

    @Test
    fun `the lease still ends when the clock steps back after its timer was set`() = runTest(UnconfinedTestDispatcher()) {
        // The receiver's clock is the test's virtual time plus an offset the test moves. The timer is
        // set for 15 s; the clock then steps back 5 s, so when the timer fires the lease has 5 s left.
        // The receiver must wait for that, not stop watching and keep the lease for ever.
        var offset = 0L
        val receiver = EventControlReceiver(
            instanceId = EventControlInstanceId.random(),
            credentials = EventControlFixtures.one,
            consent = true,
            apply = { _, _ -> EventControlAckStatus.Applied },
            now = { testScheduler.currentTime + offset },
            timers = backgroundScope
        )
        assertEquals(EventControlAckStatus.Applied, TestDirector(receiver).take(5, "gam_demoA"))
        offset = -5_000
        advanceTimeBy(15_001)
        assertNotNull("the timer fired early by the clock and waits on", receiver.overrideState)
        advanceTimeBy(5_000)
        assertNull(receiver.overrideState)
    }

    @Test
    fun `it holds the event from its apply until the lease ends, and not after an interrupted one`() = runTest {
        var during: Boolean? = null
        var interrupt = false
        lateinit var receiver: EventControlReceiver
        receiver = EventControlReceiver(
            instanceId = EventControlInstanceId.random(),
            credentials = EventControlFixtures.one,
            consent = true,
            apply = { _, _ ->
                during = receiver.holdsEvent
                if (interrupt) receiver.setConsent(false)
                EventControlAckStatus.Applied
            }
        )
        assertFalse(receiver.holdsEvent)
        val director = TestDirector(receiver)
        assertEquals(EventControlAckStatus.Applied, director.take(5, "gam_demoA"))
        assertEquals("while its apply runs", true, during)
        assertTrue("with the lease", receiver.holdsEvent)
        assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 5), director.release(5))
        assertFalse(receiver.holdsEvent)

        interrupt = true
        assertEquals(EventControlBody.Ack(EventControlAckStatus.Disabled, 6), director.assign(6, "gam_demoB"))
        assertFalse(receiver.holdsEvent)
    }

    @Test
    fun `leases are measured on elapsed real time by default`() = runTest {
        val receiver = EventControlReceiver(
            instanceId = EventControlInstanceId.random(),
            credentials = EventControlFixtures.one,
            consent = true,
            apply = { _, _ -> EventControlAckStatus.Applied }
        )
        assertEquals(EventControlAckStatus.Applied, TestDirector(receiver).take(5, "gam_demoA"))
        assertEquals(SystemClock.elapsedRealtime() + EventControlProtocol.LEASE_MS, receiver.leaseExpiresAt)
    }

    @Test
    fun `replies on a binding count as authenticated, and nothing before or outside one does`() = runTest {
        val receiver = EventControlReceiver(
            instanceId = EventControlInstanceId.random(),
            credentials = EventControlFixtures.one,
            consent = true,
            apply = { _, _ -> EventControlAckStatus.Applied }
        )
        val key = EventControlFixtures.one
        val sender = EventControlFixtures.hex("0000000000000000000000000000d001")
        val challenge = EventControlBytes.random(16)
        var nonce = ByteArray(0)
        suspend fun send(requestId: Long, body: EventControlBody, keyId: ByteArray = key.keyIdBytes): EventControlReceiverReply {
            val header = EventControlHeader(sender, requestId, key.accountTagBytes, keyId, challenge, nonce)
            val reply = receiver.handle(EventControlCodec.encode(EventControlMessage(header, body), key.keyBytes), 1, "192.0.2.10")
            val first = reply.replies.firstOrNull()?.let { EventControlCodec.decode(it).message }
            if (first?.body is EventControlBody.Announce) nonce = first.header.receiverNonce
            return reply
        }
        val assign = EventControlBody.Assign(5, "gam_demoA", "Visitors at Pioneers", "2026-09-21T18:00:00Z")

        val unbound = send(1, assign)
        assertTrue(unbound.close)
        assertFalse("an assign before any discover", unbound.authenticated)
        assertFalse("a garbage payload", receiver.handle(byteArrayOf(1, 1), 1, "192.0.2.10").authenticated)
        assertFalse("another key", send(1, EventControlBody.Discover, keyId = ByteArray(key.keyIdBytes.size)).authenticated)

        assertTrue("the announce to a valid discover", send(2, EventControlBody.Discover).authenticated)
        assertTrue("an applied assign", send(3, assign).authenticated)
        assertTrue("a retry of the last request", send(3, assign).authenticated)
        assertTrue("a stale request", send(2, EventControlBody.Renew(5)).authenticated)
        assertTrue("a renew", send(4, EventControlBody.Renew(5)).authenticated)
        assertTrue("a release", send(5, EventControlBody.Release(5)).authenticated)
        assertTrue("an expired renew still has the binding", send(6, EventControlBody.Renew(5)).authenticated)
        assertEquals(1, send(6, EventControlBody.Renew(5)).replies.size)
    }
}
