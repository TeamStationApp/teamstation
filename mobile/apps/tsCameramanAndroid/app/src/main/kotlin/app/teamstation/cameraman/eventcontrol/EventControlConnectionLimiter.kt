package app.teamstation.cameraman.eventcontrol

/** What [EventControlConnectionLimiter.admit] decided about a new connection. */
internal sealed class EventControlAdmission {
    /** Let it in; when [evict] is set, close that connection to make room. */
    data class Admitted(val evict: Long? = null) : EventControlAdmission()

    /** Close it at once: every open connection is authenticated. */
    object Refused : EventControlAdmission()
}

/**
 * The receiver's connection limits (README.md, "Transport" → "Connection limits"), with no socket
 * and no clock of its own: the caller passes the time and closes what it is told to.
 *
 * At most [maxConnections] are open. A connection not authenticated [handshakeMs] after it was
 * accepted, or authenticated but without activity for [idleMs], has expired. A new connection
 * while the limit is reached replaces the oldest connection that is not authenticated, and is
 * refused when every open one is. An authenticated connection is never closed to make room.
 *
 * Not thread-safe: the listener calls it under its own lock. A connection [admit] evicts or
 * [expired] returns is forgotten at once, so its slot is free before its socket has closed.
 */
internal class EventControlConnectionLimiter(
    private val maxConnections: Int = MAX_CONNECTIONS,
    private val handshakeMs: Long = HANDSHAKE_MS,
    private val idleMs: Long = IDLE_MS
) {
    private class Entry(val acceptedAt: Long) {
        var authenticated = false
        var lastActivity = acceptedAt
    }

    /** In the order the connections were accepted, oldest first. */
    private val entries = LinkedHashMap<Long, Entry>()

    /** How many connections are counted against the limit. */
    val size: Int get() = entries.size

    fun isAuthenticated(id: Long): Boolean = entries[id]?.authenticated == true

    fun admit(id: Long, nowMs: Long): EventControlAdmission {
        if (entries.size < maxConnections) {
            entries[id] = Entry(nowMs)
            return EventControlAdmission.Admitted()
        }
        val oldest = entries.entries.firstOrNull { !it.value.authenticated }?.key
            ?: return EventControlAdmission.Refused
        entries.remove(oldest)
        entries[id] = Entry(nowMs)
        return EventControlAdmission.Admitted(evict = oldest)
    }

    /** The receiver answered a discover on [id], or accepted a later frame on its binding. */
    fun authenticated(id: Long, nowMs: Long) {
        val entry = entries[id] ?: return
        entry.authenticated = true
        entry.lastActivity = nowMs
    }

    fun closed(id: Long) {
        entries.remove(id)
    }

    /** The connections past their handshake deadline or idle limit, now forgotten: close them. */
    fun expired(nowMs: Long): List<Long> {
        val due = entries.filter { (_, entry) ->
            if (entry.authenticated) nowMs - entry.lastActivity >= idleMs else nowMs - entry.acceptedAt >= handshakeMs
        }.keys.toList()
        due.forEach { entries.remove(it) }
        return due
    }

    companion object {
        const val MAX_CONNECTIONS = 16
        const val HANDSHAKE_MS = 5_000L
        const val IDLE_MS = EventControlProtocol.LEASE_MS
    }
}
