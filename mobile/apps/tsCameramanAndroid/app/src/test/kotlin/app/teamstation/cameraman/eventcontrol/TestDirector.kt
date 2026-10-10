package app.teamstation.cameraman.eventcontrol

/**
 * A Director talking straight to a receiver's state machine, one connection, no socket: for the
 * host and scoreboard tests. Request IDs start at 1, as a real Director's do.
 */
internal class TestDirector(
    private val receiver: EventControlReceiver,
    instance: String = "0000000000000000000000000000d001",
    val host: String = "192.0.2.10",
    private val connection: Long = 1,
    private val key: EventControlCredentials = EventControlFixtures.one
) {
    private val sender = EventControlFixtures.hex(instance)
    private val challenge = EventControlBytes.random(16)
    private var nonce = ByteArray(0)
    private var requestId = 0L

    /** The reply's body, or null when the receiver closed without one. */
    suspend fun send(body: EventControlBody): EventControlBody? {
        requestId += 1
        val header = EventControlHeader(sender, requestId, key.accountTagBytes, key.keyIdBytes, challenge, nonce)
        val payload = EventControlCodec.encode(EventControlMessage(header, body), key.keyBytes)
        val reply = receiver.handle(payload, connection, host).replies.firstOrNull() ?: return null
        val decoded = EventControlCodec.decode(reply).message
        if (decoded.body is EventControlBody.Announce) nonce = decoded.header.receiverNonce
        return decoded.body
    }

    suspend fun discover(): EventControlBody? = send(EventControlBody.Discover)

    suspend fun assign(revision: Long, game: String, title: String = "Visitors at Pioneers", startAt: String = "2026-09-21T18:00:00Z") =
        send(EventControlBody.Assign(revision, game, title, startAt))

    /** Discover, then assign; the ack's status. */
    suspend fun take(revision: Long, game: String, title: String = "Visitors at Pioneers", startAt: String = "2026-09-21T18:00:00Z"): EventControlAckStatus? {
        discover()
        return (assign(revision, game, title, startAt) as? EventControlBody.Ack)?.status
    }

    suspend fun release(revision: Long) = send(EventControlBody.Release(revision))
}
