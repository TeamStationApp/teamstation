package app.teamstation.cameraman.eventcontrol

import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Who is assigning, handed to the app's commit. */
internal data class EventControlApplyContext(
    val owner: EventControlInstanceId,
    /** The address the assignment came from, as observed on the socket, never a claimed field. */
    val ownerHost: String,
    val revision: Long
)

/** A Director's hold on this device's event: who, from where, and what it assigned. */
internal data class EventOverride(
    val owner: EventControlInstanceId,
    /** The Director's observed address, for "Override from Director 192.0.2.10". */
    val ownerHost: String,
    val revision: Long,
    val assignment: EventAssignment
)

/** Why a lease ended. In every case the last applied event stays selected. */
internal enum class EventOverrideEndReason {
    Released,
    Expired,
    ConsentOff,
    AccountChanged,
    Restarted;

    val wireName: String get() = name.replaceFirstChar { it.lowercaseChar() }
}

/** What a receiver tells its app. */
internal sealed class EventControlReceiverEvent {
    /** The lease now, or null when no Director holds it. */
    data class OverrideChanged(val current: EventOverride?) : EventControlReceiverEvent()
    data class OverrideEnded(val ended: EventOverride, val reason: EventOverrideEndReason) : EventControlReceiverEvent()

    /** A Director's key comes from another server secret: fetch this device's key again. */
    data class KeyMismatch(val peerKeyId: String) : EventControlReceiverEvent()
}

/**
 * What to send back on a connection, and whether to close it afterwards. [authenticated] is true
 * for the `announce` to a valid discover and for every later reply on that connection's binding:
 * what the listener counts as the connection's handshake and activity (README.md, "Connection
 * limits").
 */
internal data class EventControlReceiverReply(
    val replies: List<ByteArray>,
    val close: Boolean,
    val authenticated: Boolean = false
)

/**
 * The app's commit: re-check consent and the signed-in account immediately before writing, store
 * the game ID, title and start time together, move the publishing connection, and only then
 * answer [EventControlAckStatus.Applied]. Anything else it answers is sent back and leaves no lease.
 */
internal typealias EventControlApply = suspend (EventAssignment, EventControlApplyContext) -> EventControlAckStatus

/**
 * The receiving end's state machine, independent of any socket (README.md, "Receiver").
 *
 * It owns the lease (the first valid Director wins; 15 s without a renew ends it), each
 * connection's session binding (the Director's challenge and this receiver's nonce), request
 * ordering and revision ordering. The app supplies its key, its operator's consent and the commit,
 * and observes the lease through [onEvent], which is called on the thread that changed it.
 *
 * State is guarded by one lock that is not held while the commit runs, so a second Director is
 * answered `busy` meanwhile, and consent or the account can change under an apply in flight, which
 * then reports `disabled`, `wrongAccount` or `expired` instead of taking the lease.
 */
internal class EventControlReceiver(
    val instanceId: EventControlInstanceId,
    credentials: EventControlCredentials?,
    consent: Boolean,
    private val apply: EventControlApply,
    /**
     * Milliseconds on the clock leases are measured on: [SystemClock.elapsedRealtime], which setting
     * the wall clock does not move and which keeps counting while the device sleeps.
     */
    private val now: () -> Long = SystemClock::elapsedRealtime,
    private val random: (Int) -> ByteArray = EventControlBytes::random,
    /** Ends a lease on its own when it runs out. Null in tests that drive [now] and call [expireIfDue]. */
    private val timers: CoroutineScope? = null,
    private val leaseMs: Long = EventControlProtocol.LEASE_MS,
    private val onEvent: (EventControlReceiverEvent) -> Unit = {}
) {
    private class Binding(
        val director: ByteArray,
        val challenge: ByteArray,
        val nonce: ByteArray,
        var lastRequestId: Long,
        var lastReply: ByteArray?
    )

    private val lock = ReentrantLock()
    private var credentials: EventControlCredentials? = credentials
    private var consent: Boolean = consent
    private var lease: EventOverride? = null
    private var leaseExpiry: Long? = null
    private var applying = false

    /** Bumped by anything that must invalidate an apply in flight. */
    private var generation = 0L

    /**
     * The last thing that invalidated the apply in flight: what its Director is told. When several
     * happen during one apply, the last one wins, as on every receiver (README.md, "Receiver").
     */
    private var interruption: EventControlAckStatus? = null
    private val bindings = HashMap<Long, Binding>()
    private var expiryJob: Job? = null

    val overrideState: EventOverride? get() = lock.withLock { lease }
    val leaseExpiresAt: Long? get() = lock.withLock { leaseExpiry }
    val isConsenting: Boolean get() = lock.withLock { consent }
    val hasCredentials: Boolean get() = lock.withLock { credentials != null }

    /**
     * Whether a Director holds this device's event or is writing it now: a lease, or an apply in
     * flight. The app's own picker stays locked while it is true, including the moment between a
     * commit answering applied and [EventControlReceiverEvent.OverrideChanged] reaching the app.
     */
    val holdsEvent: Boolean get() = lock.withLock { lease != null || applying }

    /** Off releases at once and restores local editing; on lets the next assignment in. */
    fun setConsent(allowed: Boolean) = lock.withLock {
        if (allowed == consent) return@withLock
        consent = allowed
        if (allowed) return@withLock
        interrupt(EventControlAckStatus.Disabled)
        endLease(EventOverrideEndReason.ConsentOff)
    }

    /**
     * A new key, or none. Another account (or a key from another secret) ends the lease and every
     * session; the same key again changes nothing.
     */
    fun setCredentials(next: EventControlCredentials?) = lock.withLock {
        val current = credentials
        if (current != null && next != null && current.isSameAccount(next)) return@withLock
        credentials = next
        interrupt(EventControlAckStatus.WrongAccount)
        bindings.clear()
        endLease(EventOverrideEndReason.AccountChanged)
    }

    /** As after a process restart, or a rebuilt listener: no lease, no sessions. Consent and key stay. */
    fun restart() = lock.withLock {
        interrupt(EventControlAckStatus.Expired)
        bindings.clear()
        endLease(EventOverrideEndReason.Restarted)
    }

    /** Ends the lease if its time is up. */
    fun expireIfDue() = lock.withLock {
        val expiry = leaseExpiry ?: return@withLock
        if (now() >= expiry) endLease(EventOverrideEndReason.Expired)
    }

    /** The connection went, and its session with it. The lease does not. */
    fun connectionClosed(connection: Long) = lock.withLock {
        bindings.remove(connection)
        Unit
    }

    /** Everything a receiver does with one payload from [connection]. */
    suspend fun handle(payload: ByteArray, connection: Long, remoteHost: String): EventControlReceiverReply {
        val credentials = lock.withLock { credentials } ?: return EventControlReceiverReply(emptyList(), true)
        val key = credentials.keyBytes
        if (payload.isNotEmpty() && (payload[0].toInt() and 0xff) != EventControlProtocol.VERSION) {
            val header = EventControlHeader(
                sender = instanceId.bytes,
                requestId = 0,
                accountTag = credentials.accountTagBytes,
                keyId = credentials.keyIdBytes,
                challenge = ByteArray(EventControlProtocol.NONCE_BYTES),
                receiverNonce = ByteArray(0)
            )
            val message = EventControlMessage(header, EventControlBody.Ack(EventControlAckStatus.Unsupported, 0))
            return EventControlReceiverReply(listOf(EventControlCodec.encode(message, key)), true)
        }
        val decoded = runCatching { EventControlCodec.decode(payload) }.getOrNull()
        if (decoded == null || !decoded.message.body.type.isFromDirector) {
            return EventControlReceiverReply(emptyList(), true)
        }
        val header = decoded.message.header
        fun unbound(status: EventControlAckStatus) =
            EventControlReceiverReply(listOf(ack(status, 0, header, ByteArray(0), credentials)), true)
        if (!header.keyId.contentEquals(credentials.keyIdBytes)) {
            onEvent(EventControlReceiverEvent.KeyMismatch(EventControlBytes.hex(header.keyId)))
            return unbound(EventControlAckStatus.KeyMismatch)
        }
        if (!header.accountTag.contentEquals(credentials.accountTagBytes)) return unbound(EventControlAckStatus.WrongAccount)
        if (!decoded.isAuthentic(key)) return unbound(EventControlAckStatus.Invalid)
        expireIfDue()

        val body = decoded.message.body
        if (body is EventControlBody.Discover) return discover(header, connection, credentials)

        val revision = body.requestRevision
        val binding: Binding = lock.withLock {
            val bound = bindings[connection]
            if (bound == null || !bound.director.contentEquals(header.sender) ||
                !EventControlBytes.constantTimeEqual(bound.challenge, header.challenge) ||
                !EventControlBytes.constantTimeEqual(bound.nonce, header.receiverNonce)
            ) {
                bindings.remove(connection)
                return unbound(EventControlAckStatus.Invalid)
            }
            val last = bound.lastReply
            // A retry of the request just answered: the same answer, and nothing done twice.
            if (header.requestId == bound.lastRequestId && last != null) {
                return EventControlReceiverReply(listOf(last), false, authenticated = true)
            }
            if (java.lang.Long.compareUnsigned(header.requestId, bound.lastRequestId) <= 0) {
                return EventControlReceiverReply(
                    listOf(ack(EventControlAckStatus.Stale, revision, header, bound.nonce, credentials)),
                    false,
                    authenticated = true
                )
            }
            bound.lastRequestId = header.requestId
            bound.lastReply = null
            bound
        }

        val sender = EventControlInstanceId.of(header.sender)!!
        val status = when (body) {
            is EventControlBody.Assign -> assign(body, sender, remoteHost)
            is EventControlBody.Renew -> renew(revision, sender)
            is EventControlBody.Release -> release(sender)
            else -> EventControlAckStatus.Invalid
        }
        // The key may have changed while an apply was out; answer with the one that checked the request.
        val reply = ack(status, revision, header, binding.nonce, credentials)
        lock.withLock {
            val current = bindings[connection]
            if (current === binding && current.lastRequestId == header.requestId) current.lastReply = reply
        }
        return EventControlReceiverReply(listOf(reply), false, authenticated = true)
    }

    private fun discover(
        header: EventControlHeader,
        connection: Long,
        credentials: EventControlCredentials
    ): EventControlReceiverReply = lock.withLock {
        val nonce = random(EventControlProtocol.NONCE_BYTES)
        val held = lease
        val state = when {
            held == null -> EventControlLeaseState.Free
            held.owner.bytes.contentEquals(header.sender) -> EventControlLeaseState.HeldBySender
            else -> EventControlLeaseState.HeldByOther
        }
        val message = EventControlMessage(
            replyHeader(header, nonce, credentials),
            EventControlBody.Announce(
                consent = consent,
                lease = state,
                leaseRevision = if (state == EventControlLeaseState.HeldBySender) held!!.revision else 0L
            )
        )
        val payload = EventControlCodec.encode(message, credentials.keyBytes)
        bindings[connection] = Binding(header.sender, header.challenge, nonce, header.requestId, payload)
        EventControlReceiverReply(listOf(payload), false, authenticated = true)
    }

    private suspend fun assign(
        body: EventControlBody.Assign,
        director: EventControlInstanceId,
        host: String
    ): EventControlAckStatus {
        val assignment = runCatching {
            EventAssignment.fromWire(body.gameId, body.title, body.startAt)
        }.getOrNull() ?: return EventControlAckStatus.Invalid
        val started: Long = lock.withLock {
            if (!consent) return EventControlAckStatus.Disabled
            val held = lease
            if (held != null && held.owner != director) return EventControlAckStatus.Busy
            if (applying) return EventControlAckStatus.Busy
            if (held != null) {
                if (java.lang.Long.compareUnsigned(body.revision, held.revision) < 0) return EventControlAckStatus.Stale
                if (body.revision == held.revision) {
                    // The same assignment again, perhaps on a new connection: renew, do not re-apply.
                    if (held.assignment != assignment) return EventControlAckStatus.Invalid
                    extendLease()
                    return EventControlAckStatus.Applied
                }
            }
            applying = true
            interruption = null
            generation
        }
        val status = try {
            apply(assignment, EventControlApplyContext(director, host, body.revision))
        } catch (error: Exception) {
            EventControlAckStatus.Failed
        }
        return lock.withLock {
            applying = false
            if (generation != started) return@withLock interruption ?: EventControlAckStatus.Expired
            if (status != EventControlAckStatus.Applied) return@withLock status
            val held = EventOverride(director, host, body.revision, assignment)
            lease = held
            extendLease()
            onEvent(EventControlReceiverEvent.OverrideChanged(held))
            EventControlAckStatus.Applied
        }
    }

    private fun renew(revision: Long, director: EventControlInstanceId): EventControlAckStatus = lock.withLock {
        if (!consent) return@withLock EventControlAckStatus.Disabled
        val held = lease ?: return@withLock EventControlAckStatus.Expired
        if (held.owner != director) return@withLock EventControlAckStatus.Busy
        if (revision != held.revision) return@withLock EventControlAckStatus.Stale
        extendLease()
        EventControlAckStatus.Applied
    }

    private fun release(director: EventControlInstanceId): EventControlAckStatus = lock.withLock {
        val held = lease ?: return@withLock EventControlAckStatus.Expired
        if (held.owner != director) return@withLock EventControlAckStatus.Busy
        endLease(EventOverrideEndReason.Released)
        EventControlAckStatus.Applied
    }

    private fun interrupt(status: EventControlAckStatus) {
        generation += 1
        interruption = status
    }

    private fun extendLease() {
        leaseExpiry = now() + leaseMs
        armExpiryTimer()
    }

    /** Called with the lock held: wake when what is left of the lease has gone. */
    private fun armExpiryTimer() {
        val scope = timers ?: return
        val expiry = leaseExpiry ?: return
        expiryJob?.cancel()
        val wait = maxOf(0L, expiry - now())
        expiryJob = scope.launch {
            delay(wait)
            expiryTimerFired()
        }
    }

    /**
     * The timer ran out: end the lease if it is due, or wait again for what is left of it. A timer
     * can wake before [now] says the lease is over (it runs on another clock, or a test moved [now]
     * back); it must not then stop watching a lease that is still held.
     */
    private fun expiryTimerFired() = lock.withLock {
        expireIfDue()
        if (leaseExpiry != null) armExpiryTimer()
    }

    private fun endLease(reason: EventOverrideEndReason) {
        expiryJob?.cancel()
        expiryJob = null
        leaseExpiry = null
        val ended = lease ?: return
        lease = null
        onEvent(EventControlReceiverEvent.OverrideEnded(ended, reason))
        onEvent(EventControlReceiverEvent.OverrideChanged(null))
    }

    private fun replyHeader(header: EventControlHeader, nonce: ByteArray, credentials: EventControlCredentials) =
        EventControlHeader(
            sender = instanceId.bytes,
            requestId = header.requestId,
            accountTag = credentials.accountTagBytes,
            keyId = credentials.keyIdBytes,
            challenge = header.challenge,
            receiverNonce = nonce
        )

    private fun ack(
        status: EventControlAckStatus,
        revision: Long,
        header: EventControlHeader,
        nonce: ByteArray,
        credentials: EventControlCredentials
    ): ByteArray = EventControlCodec.encode(
        EventControlMessage(replyHeader(header, nonce, credentials), EventControlBody.Ack(status, revision)),
        credentials.keyBytes
    )
}
