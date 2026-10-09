package app.teamstation.cameraman.eventcontrol

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.BufferedOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Where the listener is. [PortsUnavailable] is the explicit error for both ports being taken. */
internal sealed class EventControlListenerState {
    object Stopped : EventControlListenerState()
    object Binding : EventControlListenerState()
    data class Listening(val port: Int) : EventControlListenerState()
    data class PortsUnavailable(val ports: List<Int>) : EventControlListenerState()
}

/**
 * The receiver's TCP listener: the first of 47614 and 47615 it can bind, one connection per
 * Director, each frame's length checked before its payload is read.
 *
 * Connections are held to the limits in README.md, "Connection limits", through an
 * [EventControlConnectionLimiter]: at most [maxConnections], a handshake deadline of
 * [handshakeMs], [idleMs] without activity once authenticated, and a new connection at the limit
 * replacing the oldest one that is not authenticated. While any connection is open, a reaper
 * checks them every [reapIntervalMs] and closes the expired ones; closing a socket ends its
 * blocking read, and the connection's own loop drops its binding. The lease is never touched.
 *
 * [start] is idempotent, so a second start never opens a second socket. [stop] closes the socket
 * and every connection and drops any lease, as a restart would. When the socket fails while it is
 * still wanted, the listener rebuilds itself after [rebindDelayMs] on the same port preference,
 * with no lease and no sessions; [ensureListening] does the same at once, for the service's start
 * and a network change.
 */
internal class EventControlListener(
    private val receiver: EventControlReceiver,
    /** Runs the accept loop and the connections; blocking I/O, so an IO dispatcher. */
    private val scope: CoroutineScope,
    private val ports: List<Int> = EventControlProtocol.PORTS,
    private val rebindDelayMs: Long = 1_000L,
    private val maxConnections: Int = EventControlConnectionLimiter.MAX_CONNECTIONS,
    /** A connection not authenticated this long after it was accepted is closed. */
    private val handshakeMs: Long = EventControlConnectionLimiter.HANDSHAKE_MS,
    /** An authenticated connection with no activity this long is closed; a Director renews every 5 s. */
    private val idleMs: Long = EventControlConnectionLimiter.IDLE_MS,
    private val reapIntervalMs: Long = 250L,
    /** Monotonic milliseconds, so a wall-clock change neither closes nor keeps a connection. */
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
    private val onStateChange: (EventControlListenerState) -> Unit = {}
) {
    private val lock = ReentrantLock()
    private var wanted = false
    private var server: ServerSocket? = null
    private var acceptJob: Job? = null
    private var rebindJob: Job? = null
    private var reapJob: Job? = null
    private var limiter = newLimiter()
    private val connections = HashMap<Long, Socket>()
    private val nextConnection = AtomicLong(0)
    private var current: EventControlListenerState = EventControlListenerState.Stopped

    val state: EventControlListenerState get() = lock.withLock { current }

    /** How many sockets this listener holds open, for the duplicate-socket checks. */
    val openConnections: Int get() = lock.withLock { connections.size }

    /** Whether the reaper is running; it runs only while a connection is open. */
    internal val isReaping: Boolean get() = lock.withLock { reapJob != null }

    fun start() = lock.withLock {
        wanted = true
        if (server != null) return@withLock
        bind()
    }

    /** Binds again unless a socket is up; for the service's start and a network change. */
    fun ensureListening() = lock.withLock {
        if (!wanted) return@withLock
        val open = server
        if (open != null && !open.isClosed) return@withLock
        rebuild(immediately = true)
    }

    fun stop() {
        val closing = lock.withLock {
            wanted = false
            rebindJob?.cancel()
            rebindJob = null
            closeAll()
        }
        closing.forEach { runCatching { it.close() } }
        receiver.restart()
        setState(EventControlListenerState.Stopped)
    }

    /** Takes the socket down without stopping, as the system can; the listener rebuilds itself. */
    internal fun dropSocketForTest() {
        lock.withLock { server }?.close()
    }

    private fun bind() {
        setState(EventControlListenerState.Binding)
        for (port in ports) {
            val socket = ServerSocket()
            try {
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(port))
            } catch (error: IOException) {
                runCatching { socket.close() }
                continue
            }
            server = socket
            setState(EventControlListenerState.Listening(socket.localPort))
            acceptJob = scope.launch { accept(socket) }
            return
        }
        setState(EventControlListenerState.PortsUnavailable(ports))
    }

    private fun accept(socket: ServerSocket) {
        while (true) {
            val client = try {
                socket.accept()
            } catch (error: IOException) {
                lock.withLock {
                    if (server === socket && wanted) rebuild(immediately = false)
                }
                return
            }
            val id = nextConnection.incrementAndGet()
            val evicted: Socket? = lock.withLock {
                val admission = if (server === socket) limiter.admit(id, now()) else EventControlAdmission.Refused
                if (admission !is EventControlAdmission.Admitted) return@withLock client
                connections[id] = client
                if (reapJob?.isActive != true) reapJob = scope.launch { reap(socket) }
                // The evicted socket stays tracked until its own loop ends, as any closed one does.
                admission.evict?.let { connections[it] }
            }
            if (evicted === client) {
                runCatching { client.close() }
                continue
            }
            evicted?.let { runCatching { it.close() } }
            scope.launch { serve(client, id) }
        }
    }

    private suspend fun serve(client: Socket, id: Long) {
        val host = client.inetAddress?.hostAddress.orEmpty()
        try {
            client.tcpNoDelay = true
            val input = client.getInputStream()
            val output = BufferedOutputStream(client.getOutputStream())
            while (true) {
                val payload = EventControlCodec.readPayload(input) ?: break
                val reply = receiver.handle(payload, id, host)
                // Marked before the reply goes out, so a Director that has it is already counted.
                if (reply.authenticated) lock.withLock { limiter.authenticated(id, now()) }
                for (answer in reply.replies) output.write(EventControlCodec.frame(answer))
                output.flush()
                if (reply.close) break
            }
        } catch (error: Exception) {
            // A refused length, a dead peer or a stop: the connection ends, and its session with it.
        } finally {
            runCatching { client.close() }
            lock.withLock {
                connections.remove(id)
                limiter.closed(id)
            }
            receiver.connectionClosed(id)
        }
    }

    /**
     * Closes the connections past their handshake deadline or idle limit, every [reapIntervalMs],
     * until no connection is open or [socket] is no longer this listener's.
     */
    private suspend fun reap(socket: ServerSocket) {
        while (true) {
            delay(reapIntervalMs)
            val closing = lock.withLock {
                if (server !== socket || connections.isEmpty()) {
                    if (server === socket) reapJob = null
                    return
                }
                limiter.expired(now()).mapNotNull { connections[it] }
            }
            closing.forEach { runCatching { it.close() } }
        }
    }

    /** Drops the socket and every session, and binds again: no lease survives a rebuilt listener. */
    private fun rebuild(immediately: Boolean) {
        val closing = closeAll()
        closing.forEach { runCatching { it.close() } }
        receiver.restart()
        if (immediately) {
            bind()
            return
        }
        setState(EventControlListenerState.Binding)
        rebindJob?.cancel()
        rebindJob = scope.launch {
            delay(rebindDelayMs)
            lock.withLock { if (wanted && server == null) bind() }
        }
    }

    /** Detaches the socket and connections; the caller closes them. Called with the lock held. */
    private fun closeAll(): List<java.io.Closeable> {
        val closing = ArrayList<java.io.Closeable>()
        server?.let { closing += it }
        server = null
        acceptJob = null
        reapJob?.cancel()
        reapJob = null
        closing += connections.values
        connections.clear()
        limiter = newLimiter()
        return closing
    }

    private fun newLimiter() = EventControlConnectionLimiter(maxConnections, handshakeMs, idleMs)

    private fun setState(next: EventControlListenerState) {
        val changed = lock.withLock {
            if (current == next) return@withLock false
            current = next
            true
        }
        if (changed) onStateChange(next)
    }
}
