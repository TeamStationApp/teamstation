package app.teamstation.cameraman.eventcontrol

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Collections

/**
 * The TCP listener: the first free port of two, an explicit error when both are taken,
 * two receivers at one address on the two ports, framing limits on the wire, stop and rebind
 * without a duplicate socket, and a rebuilt socket dropping the lease. Real sockets on loopback,
 * on ports the system hands out, so nothing here depends on 47614 being free on this machine.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventControlListenerTest {
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val held = ArrayList<ServerSocket>()
    private val listeners = ArrayList<EventControlListener>()

    @After
    fun tearDown() {
        listeners.forEach { it.stop() }
        held.forEach { it.close() }
        io.cancel()
    }

    /** Ports nobody holds right now. */
    private fun freePorts(count: Int): List<Int> = (0 until count).map {
        ServerSocket(0).use { socket -> socket.localPort }
    }

    private fun occupy(port: Int) {
        held += ServerSocket().apply { bind(InetSocketAddress(port)) }
    }

    private fun receiver(
        instance: String = "0000000000000000000000000000e001",
        events: MutableList<EventControlReceiverEvent> = Collections.synchronizedList(ArrayList())
    ) = EventControlReceiver(
        instanceId = EventControlInstanceId.of(instance)!!,
        credentials = EventControlFixtures.one,
        consent = true,
        apply = { _, _ -> EventControlAckStatus.Applied },
        onEvent = { events += it }
    )

    private fun listener(
        receiver: EventControlReceiver,
        ports: List<Int>,
        states: MutableList<EventControlListenerState> = Collections.synchronizedList(ArrayList()),
        maxConnections: Int = 16,
        handshakeMs: Long = EventControlConnectionLimiter.HANDSHAKE_MS,
        idleMs: Long = EventControlConnectionLimiter.IDLE_MS
    ) = EventControlListener(
        receiver = receiver,
        scope = io,
        ports = ports,
        rebindDelayMs = 50,
        maxConnections = maxConnections,
        handshakeMs = handshakeMs,
        idleMs = idleMs,
        reapIntervalMs = 25,
        onStateChange = { states += it }
    ).also { listeners += it }

    private fun waitFor(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    /** A Director on one connection: discover, then whatever the test sends. */
    private class Director(port: Int, private val challenge: ByteArray = EventControlBytes.random(16)) : AutoCloseable {
        val socket = Socket("127.0.0.1", port).apply { soTimeout = 5_000 }
        private val input = DataInputStream(socket.getInputStream())
        private val output = DataOutputStream(socket.getOutputStream())
        private val key = EventControlFixtures.one
        val sender = EventControlFixtures.hex("0000000000000000000000000000d001")
        var nonce = ByteArray(0)
        private var requestId = 0L

        fun send(body: EventControlBody): EventControlMessage? {
            requestId += 1
            val header = EventControlHeader(sender, requestId, key.accountTagBytes, key.keyIdBytes, challenge, nonce)
            output.write(EventControlCodec.frame(EventControlCodec.encode(EventControlMessage(header, body), key.keyBytes)))
            output.flush()
            val reply = EventControlCodec.readPayload(input) ?: return null
            val decoded = EventControlCodec.decode(reply)
            if (decoded.message.body is EventControlBody.Announce) nonce = decoded.message.header.receiverNonce
            return decoded.message
        }

        fun raw(bytes: ByteArray) {
            output.write(bytes)
            output.flush()
        }

        /** True when the receiver closed the connection. */
        fun closedByPeer(): Boolean = runCatching { input.read() == -1 }.getOrDefault(true)

        override fun close() = socket.close()
    }

    @Test
    fun `binds the first free port, and the second when the first is taken`() {
        val (first, second) = freePorts(2)
        val states = Collections.synchronizedList(ArrayList<EventControlListenerState>())
        val one = listener(receiver(), listOf(first, second), states)
        one.start()
        assertEquals(EventControlListenerState.Listening(first), one.state)
        one.start()
        assertEquals("a second start opens no second socket", listOf(EventControlListenerState.Binding, EventControlListenerState.Listening(first)), states.toList())

        // A second participating app on the same handset gets the other port, and both answer.
        val other = listener(receiver("0000000000000000000000000000e002"), listOf(first, second))
        other.start()
        assertEquals(EventControlListenerState.Listening(second), other.state)
        val senders = listOf(first, second).map { port ->
            Director(port).use { director ->
                val announce = director.send(EventControlBody.Discover)!!
                assertTrue(announce.body is EventControlBody.Announce)
                EventControlBytes.hex(announce.header.sender)
            }
        }
        assertEquals(listOf("0000000000000000000000000000e001", "0000000000000000000000000000e002"), senders)
    }

    @Test
    fun `both ports taken is an explicit error, and a later ensureListening binds`() {
        val (first, second) = freePorts(2)
        occupy(first)
        occupy(second)
        val listener = listener(receiver(), listOf(first, second))
        listener.start()
        assertEquals(EventControlListenerState.PortsUnavailable(listOf(first, second)), listener.state)
        held.removeAt(1).close()
        listener.ensureListening()
        assertEquals(EventControlListenerState.Listening(second), listener.state)
    }

    @Test
    fun `a whole exchange runs on one connection, and a lease survives the connection`() {
        val (port) = freePorts(1)
        val receiver = receiver()
        listener(receiver, listOf(port)).start()
        Director(port).use { director ->
            val announce = director.send(EventControlBody.Discover)!!.body as EventControlBody.Announce
            assertEquals(EventControlLeaseState.Free, announce.lease)
            val ack = director.send(EventControlBody.Assign(100, "gam_demoA", "Visitors at Pioneers", "2026-09-21T18:00:00Z"))!!
            assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 100), ack.body)
            assertEquals("127.0.0.1", receiver.overrideState?.ownerHost)
            assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 100), director.send(EventControlBody.Renew(100))!!.body)
        }
        waitFor("the session to close") { listeners[0].openConnections == 0 }
        assertEquals(100L, receiver.overrideState?.revision)
    }

    @Test
    fun `oversized or empty lengths close the connection unanswered`() {
        val (port) = freePorts(1)
        listener(receiver(), listOf(port)).start()
        Director(port).use { director ->
            director.raw(byteArrayOf(0, 0, 0x10, 0x01))
            assertTrue(director.closedByPeer())
        }
        Director(port).use { director ->
            director.raw(byteArrayOf(0, 0, 0, 0))
            assertTrue(director.closedByPeer())
        }
        Director(port).use { director ->
            director.raw(EventControlCodec.frame(byteArrayOf(2, 1)))
            assertTrue("a payload that does not decode closes silently", director.closedByPeer())
        }
        // Still listening for the next one.
        Director(port).use { director ->
            assertTrue(director.send(EventControlBody.Discover)!!.body is EventControlBody.Announce)
        }
    }

    @Test
    fun `stop closes everything and drops the lease, and start binds again without a duplicate`() {
        val (port) = freePorts(1)
        val events = Collections.synchronizedList(ArrayList<EventControlReceiverEvent>())
        val receiver = receiver(events = events)
        val listener = listener(receiver, listOf(port))
        listener.start()
        val director = Director(port)
        director.send(EventControlBody.Discover)
        director.send(EventControlBody.Assign(7, "gam_demoA", "Visitors at Pioneers", "2026-09-21T18:00:00Z"))
        waitFor("the connection to be tracked") { listener.openConnections == 1 }

        listener.stop()
        assertEquals(EventControlListenerState.Stopped, listener.state)
        assertTrue(director.closedByPeer())
        director.close()
        assertNull("a stopped listener holds no lease", receiver.overrideState)
        assertEquals(EventOverrideEndReason.Restarted, (events.first { it is EventControlReceiverEvent.OverrideEnded } as EventControlReceiverEvent.OverrideEnded).reason)
        assertEquals(0, listener.openConnections)
        // The port is free again: something else can take it.
        ServerSocket().use { it.reuseAddress = true; it.bind(InetSocketAddress(port)) }

        listener.start()
        listener.ensureListening()
        assertEquals(EventControlListenerState.Listening(port), listener.state)
        Director(port).use { again ->
            val announce = again.send(EventControlBody.Discover)!!.body as EventControlBody.Announce
            assertEquals(EventControlLeaseState.Free, announce.lease)
        }
    }

    @Test
    fun `a socket the system takes down is rebuilt on the same port, with a fresh session and no lease`() {
        val (port) = freePorts(1)
        val receiver = receiver()
        val states = Collections.synchronizedList(ArrayList<EventControlListenerState>())
        val listener = listener(receiver, listOf(port), states)
        listener.start()
        Director(port).use { director ->
            director.send(EventControlBody.Discover)
            director.send(EventControlBody.Assign(9, "gam_demoA", "Visitors at Pioneers", "2026-09-21T18:00:00Z"))
            val nonce = director.nonce
            listener.dropSocketForTest()
            waitFor("the rebind") { states.count { it == EventControlListenerState.Listening(port) } == 2 }
            assertNull(receiver.overrideState)
            Director(port).use { next ->
                next.send(EventControlBody.Discover)
                assertNotEquals(EventControlBytes.hex(nonce), EventControlBytes.hex(next.nonce))
            }
        }
        // ensureListening on a live socket changes nothing.
        listener.ensureListening()
        assertEquals(2, states.count { it == EventControlListenerState.Listening(port) })
    }

    @Test
    fun `connections over the cap are closed at once, and ensureListening does nothing while stopped`() {
        val (port) = freePorts(1)
        val listener = listener(receiver(), listOf(port), maxConnections = 1)
        listener.ensureListening()
        assertEquals(EventControlListenerState.Stopped, listener.state)
        listener.start()
        Director(port).use { first ->
            first.send(EventControlBody.Discover)
            Director(port).use { second ->
                assertTrue(second.closedByPeer())
            }
            assertArrayEquals(EventControlFixtures.one.accountTagBytes, first.send(EventControlBody.Discover)!!.header.accountTag)
        }
    }

    /** Waits up to [ms] for the receiver to close [socket]: true when it did, false when it stayed open. */
    private fun closedWithin(socket: Socket, ms: Int): Boolean {
        socket.soTimeout = ms
        return try {
            socket.getInputStream().read() == -1
        } catch (timeout: SocketTimeoutException) {
            false
        } catch (error: IOException) {
            true
        }
    }

    private fun elapsedMs(since: Long) = (System.nanoTime() - since) / 1_000_000

    @Test
    fun `sixteen idle connections do not lock a Director out, which replaces the oldest and is applied`() {
        val (port) = freePorts(1)
        val receiver = receiver()
        val listener = listener(receiver, listOf(port))
        listener.start()
        val idle = (1..16).map { Socket("127.0.0.1", port) }
        try {
            waitFor("sixteen connections") { listener.openConnections == 16 }
            Director(port).use { director ->
                assertTrue(director.send(EventControlBody.Discover)!!.body is EventControlBody.Announce)
                val ack = director.send(EventControlBody.Assign(3, "gam_demoA", "Visitors at Pioneers", "2026-09-21T18:00:00Z"))!!
                assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 3), ack.body)
                assertTrue("the oldest idle connection made room", closedWithin(idle[0], 2_000))
                assertFalse("only the oldest", closedWithin(idle[1], 100))
            }
            assertEquals(3L, receiver.overrideState?.revision)
        } finally {
            idle.forEach { it.close() }
        }
    }

    @Test
    fun `a connection that never completes its handshake is closed at the deadline`() {
        val (port) = freePorts(1)
        val listener = listener(receiver(), listOf(port), handshakeMs = 300, idleMs = 60_000)
        listener.start()
        Director(port).use { half ->
            val started = System.nanoTime()
            // A length and two bytes of the payload it promises: a partial frame is no handshake.
            half.raw(byteArrayOf(0, 0, 0, 40, 1, 1))
            assertTrue(closedWithin(half.socket, 3_000))
            val elapsed = elapsedMs(started)
            assertTrue("closed after $elapsed ms", elapsed >= 250)
        }
        waitFor("the connection to go") { listener.openConnections == 0 }
        waitFor("the reaper to stop with nothing open") { !listener.isReaping }
        Director(port).use { director ->
            assertTrue(director.send(EventControlBody.Discover)!!.body is EventControlBody.Announce)
            assertTrue("the next connection starts it again", listener.isReaping)
        }
    }

    @Test
    fun `an authenticated connection stays while it renews, and once it stops is closed with the lease kept`() {
        val (port) = freePorts(1)
        val receiver = receiver()
        val listener = listener(receiver, listOf(port), handshakeMs = 200, idleMs = 600)
        listener.start()
        Director(port).use { director ->
            director.send(EventControlBody.Discover)
            val ack = director.send(EventControlBody.Assign(4, "gam_demoA", "Visitors at Pioneers", "2026-09-21T18:00:00Z"))!!
            assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 4), ack.body)
            // 1.2 s of renews, past both the handshake deadline and the idle limit: activity keeps it.
            repeat(6) {
                Thread.sleep(200)
                assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 4), director.send(EventControlBody.Renew(4))!!.body)
            }
            val stopped = System.nanoTime()
            assertTrue(closedWithin(director.socket, 3_000))
            val elapsed = elapsedMs(stopped)
            assertTrue("closed after $elapsed ms", elapsed >= 500)
        }
        waitFor("the connection to go") { listener.openConnections == 0 }
        assertEquals("closing the connection leaves the lease", 4L, receiver.overrideState?.revision)
    }

    @Test
    fun `with sixteen authenticated connections open a new one is closed at once`() {
        val (port) = freePorts(1)
        val listener = listener(receiver(), listOf(port))
        listener.start()
        val directors = (1..16).map { Director(port) }
        try {
            directors.forEach { assertTrue(it.send(EventControlBody.Discover)!!.body is EventControlBody.Announce) }
            Socket("127.0.0.1", port).use { extra -> assertTrue(closedWithin(extra, 2_000)) }
            directors.forEach { assertTrue(it.send(EventControlBody.Discover)!!.body is EventControlBody.Announce) }
            assertEquals(16, listener.openConnections)
        } finally {
            directors.forEach { it.close() }
        }
    }
}
