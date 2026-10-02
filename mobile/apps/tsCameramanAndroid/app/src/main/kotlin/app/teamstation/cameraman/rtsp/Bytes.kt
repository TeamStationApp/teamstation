package app.teamstation.cameraman.rtsp

import java.io.ByteArrayOutputStream

/**
 * Big-endian byte assembly, which is the only byte order anything in RTP, RTCP or interleaved
 * framing uses.
 *
 * Swift's `Data.append(bigEndian:)` extensions have no Kotlin equivalent, and `ByteBuffer` would
 * make every packetizer carry a capacity it has to get right in advance. This keeps the packetizers
 * reading like the wire format they implement.
 */
internal class ByteBuilder(capacity: Int = 32) {
    private val stream = ByteArrayOutputStream(capacity)

    fun byte(value: Int): ByteBuilder {
        stream.write(value and 0xFF)
        return this
    }

    fun uint16(value: Int): ByteBuilder {
        stream.write((value ushr 8) and 0xFF)
        stream.write(value and 0xFF)
        return this
    }

    fun uint32(value: Long): ByteBuilder {
        stream.write(((value ushr 24) and 0xFF).toInt())
        stream.write(((value ushr 16) and 0xFF).toInt())
        stream.write(((value ushr 8) and 0xFF).toInt())
        stream.write((value and 0xFF).toInt())
        return this
    }

    fun bytes(value: ByteArray): ByteBuilder {
        stream.write(value, 0, value.size)
        return this
    }

    fun bytes(value: ByteArray, offset: Int, count: Int): ByteBuilder {
        stream.write(value, offset, count)
        return this
    }

    val size: Int get() = stream.size()

    fun build(): ByteArray = stream.toByteArray()
}
