package app.teamstation.cameraman.eventcontrol

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Device event control, version 2: the constants every implementation shares. The specification
 * is `mobile/apps/common/EventControl/README.md`; the shared fixtures in its `Tests/Fixtures` are
 * the contract, and this app's test resources hold byte-identical copies.
 */
internal object EventControlProtocol {
    const val VERSION = 2
    val PORTS = listOf(47614, 47615)
    const val MAX_PAYLOAD = 4096
    const val RENEW_MS = 5_000L
    const val LEASE_MS = 15_000L
    const val INSTANCE_ID_BYTES = 16
    const val NONCE_BYTES = 16
    const val ACCOUNT_TAG_BYTES = 16
    const val KEY_ID_BYTES = 8
    const val KEY_BYTES = 32
    const val MAC_BYTES = 32
    const val MAX_GAME_ID_BYTES = 128
    const val MAX_TITLE_BYTES = 256
    const val START_AT_BYTES = 20
    const val FRAME_DOMAIN = "device-event-control:v2:frame"
}

internal enum class EventControlMessageType(val byte: Int) {
    Discover(1),
    Announce(2),
    Assign(3),
    Ack(4),
    Renew(5),
    Release(6);

    /** The four a Director sends. A receiver ignores the other two. */
    val isFromDirector: Boolean get() = this == Discover || this == Assign || this == Renew || this == Release

    companion object {
        fun of(byte: Int): EventControlMessageType? = entries.firstOrNull { it.byte == byte }
    }
}

/** An ack's status, in wire order: the byte is the ordinal. */
internal enum class EventControlAckStatus {
    Applied,
    Disabled,
    WrongAccount,
    Busy,
    Unsupported,
    Invalid,
    Stale,
    Expired,
    Failed,
    KeyMismatch;

    /** The fixtures' spelling: `applied`, `wrongAccount`. */
    val wireName: String get() = name.replaceFirstChar { it.lowercaseChar() }

    companion object {
        fun of(byte: Int): EventControlAckStatus? = entries.getOrNull(byte)
        fun named(name: String): EventControlAckStatus? = entries.firstOrNull { it.wireName == name }
    }
}

/** What an announce says about the lease, from the asking Director's side. */
internal enum class EventControlLeaseState {
    Free,
    HeldBySender,
    HeldByOther;

    val wireName: String get() = name.replaceFirstChar { it.lowercaseChar() }

    companion object {
        fun of(byte: Int): EventControlLeaseState? = entries.getOrNull(byte)
        fun named(name: String): EventControlLeaseState? = entries.firstOrNull { it.wireName == name }
    }
}

/** Bytes, hex, HMAC and the `lp(x)` field encoding. */
internal object EventControlBytes {
    private val random = SecureRandom()
    private const val DIGITS = "0123456789abcdef"

    fun random(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }

    fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            val value = byte.toInt() and 0xff
            out.append(DIGITS[value ushr 4]).append(DIGITS[value and 0x0f])
        }
        return out.toString()
    }

    /** Lower- or upper-case hex of even length, or null. */
    fun fromHex(text: String): ByteArray? {
        if (text.length % 2 != 0) return null
        val out = ByteArray(text.length / 2)
        for (index in out.indices) {
            val high = Character.digit(text[index * 2], 16)
            val low = Character.digit(text[index * 2 + 1], 16)
            if (high < 0 || low < 0) return null
            out[index] = ((high shl 4) or low).toByte()
        }
        return out
    }

    /** Compares every byte whatever it finds, so the time taken says nothing about where they differ. */
    fun constantTimeEqual(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    fun u64(value: Long): ByteArray = ByteArray(8) { index -> (value ushr (56 - index * 8)).toByte() }

    fun readU64(bytes: ByteArray, at: Int = 0): Long {
        var value = 0L
        for (index in 0 until 8) value = (value shl 8) or (bytes[at + index].toLong() and 0xff)
        return value
    }

    /** `u16be(byteLength) || bytes` for each part. */
    fun lengthPrefixed(parts: List<ByteArray>): ByteArray {
        var size = 0
        for (part in parts) {
            require(part.size <= 0xffff) { "a field is over 65535 bytes" }
            size += 2 + part.size
        }
        val out = ByteArray(size)
        var at = 0
        for (part in parts) {
            out[at] = (part.size ushr 8).toByte()
            out[at + 1] = part.size.toByte()
            part.copyInto(out, at + 2)
            at += 2 + part.size
        }
        return out
    }

    fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        for (part in parts) mac.update(part)
        return mac.doFinal()
    }
}
