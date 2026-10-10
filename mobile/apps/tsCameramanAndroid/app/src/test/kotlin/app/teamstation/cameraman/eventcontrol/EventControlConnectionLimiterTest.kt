package app.teamstation.cameraman.eventcontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The connection limits of README.md, "Connection limits", one rule at a time, on a given clock. */
class EventControlConnectionLimiterTest {
    private val admitted = EventControlAdmission.Admitted()

    private fun full(limiter: EventControlConnectionLimiter, count: Int = 16, at: Long = 0) {
        for (id in 1L..count) assertEquals(admitted, limiter.admit(id, at))
    }

    @Test
    fun `the defaults are sixteen connections, five seconds to authenticate and the lease to stay idle`() {
        assertEquals(16, EventControlConnectionLimiter.MAX_CONNECTIONS)
        assertEquals(5_000L, EventControlConnectionLimiter.HANDSHAKE_MS)
        assertEquals(EventControlProtocol.LEASE_MS, EventControlConnectionLimiter.IDLE_MS)
    }

    @Test
    fun `admits up to the cap without evicting anything`() {
        val limiter = EventControlConnectionLimiter()
        full(limiter)
        assertEquals(16, limiter.size)
    }

    @Test
    fun `at the cap a new connection evicts the oldest that is not authenticated`() {
        val limiter = EventControlConnectionLimiter()
        full(limiter)
        limiter.authenticated(1, 10)
        limiter.authenticated(2, 10)
        assertEquals(EventControlAdmission.Admitted(evict = 3), limiter.admit(17, 20))
        assertEquals(EventControlAdmission.Admitted(evict = 4), limiter.admit(18, 20))
        assertEquals(16, limiter.size)
        assertTrue("an authenticated connection is kept", limiter.isAuthenticated(1))
    }

    @Test
    fun `an authenticated connection is never evicted, and with all authenticated the new one is refused`() {
        val limiter = EventControlConnectionLimiter()
        full(limiter)
        for (id in 1L..16) limiter.authenticated(id, 1)
        assertEquals(EventControlAdmission.Refused, limiter.admit(17, 2))
        assertEquals(16, limiter.size)
        assertFalse(limiter.isAuthenticated(17))
    }

    @Test
    fun `a closed connection frees its slot`() {
        val limiter = EventControlConnectionLimiter(maxConnections = 2)
        limiter.admit(1, 0)
        limiter.admit(2, 0)
        limiter.authenticated(1, 0)
        limiter.authenticated(2, 0)
        assertEquals(EventControlAdmission.Refused, limiter.admit(3, 0))
        limiter.closed(2)
        assertEquals(admitted, limiter.admit(4, 0))
        limiter.closed(99)
        assertEquals(2, limiter.size)
    }

    @Test
    fun `a connection not authenticated by the handshake deadline expires`() {
        val limiter = EventControlConnectionLimiter()
        limiter.admit(1, 1_000)
        limiter.admit(2, 2_000)
        assertEquals(emptyList<Long>(), limiter.expired(5_999))
        assertEquals(listOf(1L), limiter.expired(6_000))
        assertEquals("an expired connection is forgotten", 1, limiter.size)
        assertEquals(listOf(2L), limiter.expired(7_000))
        assertEquals(emptyList<Long>(), limiter.expired(100_000))
    }

    @Test
    fun `an authenticated connection expires only after the idle limit without activity`() {
        val limiter = EventControlConnectionLimiter()
        limiter.admit(1, 0)
        limiter.authenticated(1, 4_000)
        assertEquals("authenticated before its deadline, the handshake rule no longer applies", emptyList<Long>(), limiter.expired(18_999))
        limiter.authenticated(1, 18_000)
        assertEquals("activity restarts the idle limit", emptyList<Long>(), limiter.expired(32_999))
        assertEquals(listOf(1L), limiter.expired(33_000))
        assertEquals(0, limiter.size)
    }

    @Test
    fun `activity on a connection it does not hold changes nothing`() {
        val limiter = EventControlConnectionLimiter(maxConnections = 1, handshakeMs = 100, idleMs = 200)
        limiter.authenticated(7, 0)
        assertEquals(0, limiter.size)
        assertFalse(limiter.isAuthenticated(7))
        limiter.admit(1, 0)
        assertEquals(EventControlAdmission.Admitted(evict = 1), limiter.admit(2, 50))
        limiter.authenticated(1, 60)
        assertFalse("an evicted connection stays forgotten", limiter.isAuthenticated(1))
        assertEquals(listOf(2L), limiter.expired(150))
    }
}
