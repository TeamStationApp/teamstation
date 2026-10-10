package app.teamstation.cameraman.eventcontrol

import org.json.JSONObject
import java.net.URI

internal class EventControlCredentialsException(message: String) : Exception(message)

/**
 * What `GET /api/v1/device-event-control/key` answers, held by a signed-in device: the account
 * scope (issuing server, user ID in decimal, opaque account tag), the key ID and the key.
 *
 * Each device fetches its own with its own session; devices of one account on one server hold
 * equal ones. The key authenticates the local protocol and nothing else, so it lives only in the
 * Keystore-backed [EventControlKeyStore], and [toString] leaves it out.
 */
internal class EventControlCredentials private constructor(
    val issuer: String,
    val userId: String,
    val accountTag: String,
    val keyId: String,
    private val keyHex: String
) {
    val keyBytes: ByteArray get() = EventControlBytes.fromHex(keyHex)!!
    val accountTagBytes: ByteArray get() = EventControlBytes.fromHex(accountTag)!!
    val keyIdBytes: ByteArray get() = EventControlBytes.fromHex(keyId)!!

    /** Same account on the same server: equal scope and key. */
    fun isSameAccount(other: EventControlCredentials): Boolean =
        issuer == other.issuer && userId == other.userId && accountTag == other.accountTag &&
            keyId == other.keyId &&
            EventControlBytes.constantTimeEqual(keyBytes, other.keyBytes)

    /** The server's shape, for the encrypted store only. */
    fun toJson(): String = JSONObject()
        .put("version", 1)
        .put("issuer", issuer)
        .put("userId", userId)
        .put("accountTag", accountTag)
        .put("keyId", keyId)
        .put("key", keyHex)
        .toString()

    override fun equals(other: Any?): Boolean = other is EventControlCredentials && isSameAccount(other)

    override fun hashCode(): Int = (issuer + userId + accountTag + keyId).hashCode()

    override fun toString(): String =
        "EventControlCredentials(issuer=$issuer, userId=$userId, accountTag=$accountTag, keyId=$keyId, key=<redacted>)"

    companion object {
        /** Checks every field's shape; a credential that passes can always sign and verify. */
        fun of(issuer: String, userId: String, accountTag: String, keyId: String, key: String): EventControlCredentials {
            if (issuer.isEmpty() || EventControlBytes.utf8(issuer).size > 512) {
                throw EventControlCredentialsException("bad issuer")
            }
            if (userId.isEmpty() || userId.length > 32 || !userId.all { it in '0'..'9' }) {
                throw EventControlCredentialsException("bad userId")
            }
            if (!lowerHex(accountTag, EventControlProtocol.ACCOUNT_TAG_BYTES)) {
                throw EventControlCredentialsException("bad accountTag")
            }
            if (!lowerHex(keyId, EventControlProtocol.KEY_ID_BYTES)) {
                throw EventControlCredentialsException("bad keyId")
            }
            if (!lowerHex(key, EventControlProtocol.KEY_BYTES)) {
                throw EventControlCredentialsException("bad key")
            }
            return EventControlCredentials(issuer, userId, accountTag, keyId, key)
        }

        /** The server's JSON reply. `userId` is read as a string or, defensively, a JSON number. */
        fun decode(serverReply: String): EventControlCredentials {
            val json = try {
                JSONObject(serverReply)
            } catch (error: Exception) {
                throw EventControlCredentialsException("not a key reply")
            }
            if (json.has("version") && json.opt("version") != 1) {
                throw EventControlCredentialsException("unsupported key version")
            }
            val userId = when (val raw = json.opt("userId")) {
                is String -> raw
                is Int, is Long -> raw.toString()
                else -> throw EventControlCredentialsException("bad userId")
            }
            return of(
                issuer = json.optString("issuer"),
                userId = userId,
                accountTag = json.optString("accountTag"),
                keyId = json.optString("keyId"),
                key = json.optString("key")
            )
        }

        /**
         * `scheme://host[:port]` in lower case with the scheme's default port dropped: the name a
         * device files its cached key under, so a key fetched from one server is never offered on
         * another. Null when [server] names no host.
         */
        fun canonicalOrigin(server: String): String? {
            val uri = runCatching { URI(server.trim()) }.getOrNull() ?: return null
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            val port = uri.port
            val defaultPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            return if (port < 0 || defaultPort) "$scheme://$host" else "$scheme://$host:$port"
        }

        private fun lowerHex(text: String, bytes: Int): Boolean =
            text.length == bytes * 2 && text.all { it in '0'..'9' || it in 'a'..'f' }
    }
}

/** A device's random identity on the protocol: 16 bytes, made once per installation and kept. */
internal class EventControlInstanceId private constructor(val bytes: ByteArray) {
    val hex: String get() = EventControlBytes.hex(bytes)

    override fun equals(other: Any?): Boolean =
        other is EventControlInstanceId && bytes.contentEquals(other.bytes)

    override fun hashCode(): Int = bytes.contentHashCode()

    override fun toString(): String = hex

    companion object {
        fun of(bytes: ByteArray): EventControlInstanceId? =
            if (bytes.size == EventControlProtocol.INSTANCE_ID_BYTES) EventControlInstanceId(bytes.copyOf()) else null

        fun of(hex: String): EventControlInstanceId? = EventControlBytes.fromHex(hex)?.let(::of)

        fun random(): EventControlInstanceId =
            EventControlInstanceId(EventControlBytes.random(EventControlProtocol.INSTANCE_ID_BYTES))
    }
}
