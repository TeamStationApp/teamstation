package app.teamstation.cameraman.eventcontrol

import java.io.EOFException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

internal enum class EventControlCodecError {
    TooLarge,
    TooShort,
    UnsupportedVersion,
    UnknownType,
    Truncated,
    FieldTooLong,
    BadFieldLength,
    TrailingBytes,
    BadValue,
    BadUTF8;

    val wireName: String get() = name.replaceFirstChar { it.lowercaseChar() }
}

/** Why a payload or a frame length was refused, with the field (or version or type byte) it names. */
internal class EventControlCodecException(
    val error: EventControlCodecError,
    val index: Int? = null
) : Exception(if (index == null) error.wireName else "${error.wireName}($index)")

/** The six fields every message starts with. */
internal class EventControlHeader(
    val sender: ByteArray,
    val requestId: Long,
    val accountTag: ByteArray,
    val keyId: ByteArray,
    val challenge: ByteArray,
    /** Empty or 16 bytes. */
    val receiverNonce: ByteArray
)

internal sealed class EventControlBody {
    abstract val type: EventControlMessageType

    object Discover : EventControlBody() {
        override val type = EventControlMessageType.Discover
    }

    data class Announce(val consent: Boolean, val lease: EventControlLeaseState, val leaseRevision: Long) : EventControlBody() {
        override val type = EventControlMessageType.Announce
    }

    data class Assign(val revision: Long, val gameId: String, val title: String, val startAt: String) : EventControlBody() {
        override val type = EventControlMessageType.Assign
    }

    data class Ack(val status: EventControlAckStatus, val revision: Long) : EventControlBody() {
        override val type = EventControlMessageType.Ack
    }

    data class Renew(val revision: Long) : EventControlBody() {
        override val type = EventControlMessageType.Renew
    }

    data class Release(val revision: Long) : EventControlBody() {
        override val type = EventControlMessageType.Release
    }

    /** The revision an assign, renew or release carries; 0 for the rest. */
    val requestRevision: Long
        get() = when (this) {
            is Assign -> revision
            is Renew -> revision
            is Release -> revision
            else -> 0L
        }
}

internal class EventControlMessage(val header: EventControlHeader, val body: EventControlBody)

/** A payload taken apart: the message, the bytes its MAC covers after the domain, and the MAC. */
internal class EventControlDecoded(
    val message: EventControlMessage,
    private val signed: ByteArray,
    private val mac: ByteArray
) {
    /** Whether [key] made the MAC, compared in constant time. */
    fun isAuthentic(key: ByteArray): Boolean =
        EventControlBytes.constantTimeEqual(EventControlCodec.mac(signed, key), mac)
}

/**
 *     frame   = u32be(payloadLength) || payload            1 <= payloadLength <= 4096
 *     payload = version (u8) || type (u8) || field* || mac (32 bytes)
 *     field   = u16be(byteLength) || bytes
 *     mac     = HMAC-SHA256(key, lp("device-event-control:v2:frame") || version || type || field*)
 */
internal object EventControlCodec {
    private class Spec(val min: Int, val max: Int, val only: Set<Int>? = null)

    private fun exact(size: Int) = Spec(size, size)

    private val HEADER = listOf(
        exact(EventControlProtocol.INSTANCE_ID_BYTES),
        exact(8),
        exact(EventControlProtocol.ACCOUNT_TAG_BYTES),
        exact(EventControlProtocol.KEY_ID_BYTES),
        exact(EventControlProtocol.NONCE_BYTES),
        Spec(0, EventControlProtocol.NONCE_BYTES, setOf(0, EventControlProtocol.NONCE_BYTES))
    )

    private val BODIES = mapOf(
        EventControlMessageType.Discover to emptyList(),
        EventControlMessageType.Announce to listOf(exact(1), exact(1), exact(8)),
        EventControlMessageType.Assign to listOf(
            exact(8),
            Spec(1, EventControlProtocol.MAX_GAME_ID_BYTES),
            Spec(1, EventControlProtocol.MAX_TITLE_BYTES),
            exact(EventControlProtocol.START_AT_BYTES)
        ),
        EventControlMessageType.Ack to listOf(exact(1), exact(8)),
        EventControlMessageType.Renew to listOf(exact(8)),
        EventControlMessageType.Release to listOf(exact(8))
    )

    private val DOMAIN = EventControlBytes.lengthPrefixed(listOf(EventControlBytes.utf8(EventControlProtocol.FRAME_DOMAIN)))

    fun signedBytes(message: EventControlMessage): ByteArray {
        val header = message.header
        val fields = arrayListOf(
            header.sender,
            EventControlBytes.u64(header.requestId),
            header.accountTag,
            header.keyId,
            header.challenge,
            header.receiverNonce
        )
        when (val body = message.body) {
            EventControlBody.Discover -> Unit
            is EventControlBody.Announce -> {
                fields += byteArrayOf(if (body.consent) 1 else 0)
                fields += byteArrayOf(body.lease.ordinal.toByte())
                fields += EventControlBytes.u64(body.leaseRevision)
            }
            is EventControlBody.Assign -> {
                fields += EventControlBytes.u64(body.revision)
                fields += EventControlBytes.utf8(body.gameId)
                fields += EventControlBytes.utf8(body.title)
                fields += EventControlBytes.utf8(body.startAt)
            }
            is EventControlBody.Ack -> {
                fields += byteArrayOf(body.status.ordinal.toByte())
                fields += EventControlBytes.u64(body.revision)
            }
            is EventControlBody.Renew -> fields += EventControlBytes.u64(body.revision)
            is EventControlBody.Release -> fields += EventControlBytes.u64(body.revision)
        }
        return byteArrayOf(EventControlProtocol.VERSION.toByte(), message.body.type.byte.toByte()) +
            EventControlBytes.lengthPrefixed(fields)
    }

    fun mac(signed: ByteArray, key: ByteArray): ByteArray = EventControlBytes.hmac(key, DOMAIN, signed)

    /** The signed payload for [message]. */
    fun encode(message: EventControlMessage, key: ByteArray): ByteArray {
        val signed = signedBytes(message)
        return signed + mac(signed, key)
    }

    /** A payload with its four-byte length in front. */
    fun frame(payload: ByteArray): ByteArray =
        ByteBuffer.allocate(4 + payload.size).putInt(payload.size).put(payload).array()

    /** Takes a payload apart, checking each length against its maximum before reading its bytes. */
    fun decode(payload: ByteArray): EventControlDecoded {
        if (payload.size > EventControlProtocol.MAX_PAYLOAD) throw EventControlCodecException(EventControlCodecError.TooLarge)
        if (payload.size < 2) throw EventControlCodecException(EventControlCodecError.TooShort)
        val version = payload[0].toInt() and 0xff
        if (version != EventControlProtocol.VERSION) {
            throw EventControlCodecException(EventControlCodecError.UnsupportedVersion, version)
        }
        val typeByte = payload[1].toInt() and 0xff
        val type = EventControlMessageType.of(typeByte)
            ?: throw EventControlCodecException(EventControlCodecError.UnknownType, typeByte)
        if (payload.size < 2 + EventControlProtocol.MAC_BYTES) throw EventControlCodecException(EventControlCodecError.TooShort)
        val end = payload.size - EventControlProtocol.MAC_BYTES
        var at = 2
        val fields = ArrayList<ByteArray>()
        for ((index, spec) in (HEADER + BODIES.getValue(type)).withIndex()) {
            if (end - at < 2) throw EventControlCodecException(EventControlCodecError.Truncated)
            val length = ((payload[at].toInt() and 0xff) shl 8) or (payload[at + 1].toInt() and 0xff)
            if (length > spec.max) throw EventControlCodecException(EventControlCodecError.FieldTooLong, index)
            if (end - at - 2 < length) throw EventControlCodecException(EventControlCodecError.Truncated)
            if (length < spec.min || (spec.only != null && length !in spec.only)) {
                throw EventControlCodecException(EventControlCodecError.BadFieldLength, index)
            }
            fields += payload.copyOfRange(at + 2, at + 2 + length)
            at += 2 + length
        }
        if (at != end) throw EventControlCodecException(EventControlCodecError.TrailingBytes)
        val header = EventControlHeader(
            sender = fields[0],
            requestId = EventControlBytes.readU64(fields[1]),
            accountTag = fields[2],
            keyId = fields[3],
            challenge = fields[4],
            receiverNonce = fields[5]
        )
        val body = body(type, fields.subList(6, fields.size))
        return EventControlDecoded(
            EventControlMessage(header, body),
            payload.copyOfRange(0, end),
            payload.copyOfRange(end, payload.size)
        )
    }

    private fun body(type: EventControlMessageType, fields: List<ByteArray>): EventControlBody {
        fun text(offset: Int): String = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(fields[offset]))
                .toString()
        } catch (error: CharacterCodingException) {
            throw EventControlCodecException(EventControlCodecError.BadUTF8, 6 + offset)
        }
        fun byte(offset: Int): Int = fields[offset][0].toInt() and 0xff
        return when (type) {
            EventControlMessageType.Discover -> EventControlBody.Discover
            EventControlMessageType.Announce -> {
                if (byte(0) > 1) throw EventControlCodecException(EventControlCodecError.BadValue, 6)
                val lease = EventControlLeaseState.of(byte(1))
                    ?: throw EventControlCodecException(EventControlCodecError.BadValue, 7)
                EventControlBody.Announce(byte(0) == 1, lease, EventControlBytes.readU64(fields[2]))
            }
            EventControlMessageType.Assign -> EventControlBody.Assign(
                revision = EventControlBytes.readU64(fields[0]),
                gameId = text(1),
                title = text(2),
                startAt = text(3)
            )
            EventControlMessageType.Ack -> {
                val status = EventControlAckStatus.of(byte(0))
                    ?: throw EventControlCodecException(EventControlCodecError.BadValue, 6)
                EventControlBody.Ack(status, EventControlBytes.readU64(fields[1]))
            }
            EventControlMessageType.Renew -> EventControlBody.Renew(EventControlBytes.readU64(fields[0]))
            EventControlMessageType.Release -> EventControlBody.Release(EventControlBytes.readU64(fields[0]))
        }
    }

    /**
     * The length a four-byte prefix declares. 0, or over 4096, is refused here, before anything is
     * allocated for the payload.
     */
    fun payloadLength(prefix: ByteArray): Int {
        val length = ByteBuffer.wrap(prefix, 0, 4).int.toLong() and 0xffffffffL
        if (length == 0L) throw EventControlCodecException(EventControlCodecError.TooShort)
        if (length > EventControlProtocol.MAX_PAYLOAD) throw EventControlCodecException(EventControlCodecError.TooLarge)
        return length.toInt()
    }

    /**
     * The next payload on [input], or null at a clean end of stream. Throws
     * [EventControlCodecException] for a refused length, before reading or allocating the payload.
     */
    fun readPayload(input: InputStream): ByteArray? {
        val prefix = ByteArray(4)
        val first = input.read(prefix, 0, 4)
        if (first < 0) return null
        readFully(input, prefix, first)
        val payload = ByteArray(payloadLength(prefix))
        readFully(input, payload, 0)
        return payload
    }

    private fun readFully(input: InputStream, into: ByteArray, from: Int) {
        var at = from
        while (at < into.size) {
            val count = input.read(into, at, into.size - at)
            if (count < 0) throw EOFException()
            at += count
        }
    }
}
