package app.teamstation.cameraman.rtsp

import app.teamstation.cameraman.core.DeviceIdentity
import kotlin.math.floor

/**
 * Builds the RTCP packets that accompany each RTP stream: a sender report so a receiver can map RTP
 * timestamps onto a wall clock, and a source description carrying the camera's identity.
 *
 * The identity travels as `CNAME` and `NAME` items (RFC 3550 §6.5). That is the standard place for
 * it, so a client that knows nothing about this app still reads it.
 */
class RTCPWriter(private val ssrc: Long, private val identity: DeviceIdentity) {

    /**
     * A sender report and a source description sent as one compound packet, which RFC 3550 §6.1
     * requires: every compound packet must lead with a report and carry an SDES with a CNAME.
     */
    fun compoundPacket(
        ntpTime: Long,
        rtpTimestamp: Long,
        packetCount: Long,
        octetCount: Long
    ): ByteArray {
        val builder = ByteBuilder()
        builder.bytes(senderReport(ntpTime, rtpTimestamp, packetCount, octetCount))
        builder.bytes(sourceDescription())
        return builder.build()
    }

    fun senderReport(
        ntpTime: Long,
        rtpTimestamp: Long,
        packetCount: Long,
        octetCount: Long
    ): ByteArray {
        val body = ByteBuilder(24)
        body.uint32(ssrc and 0xFFFFFFFFL)
        body.uint32((ntpTime ushr 32) and 0xFFFFFFFFL)
        body.uint32(ntpTime and 0xFFFFFFFFL)
        body.uint32(rtpTimestamp and 0xFFFFFFFFL)
        body.uint32(packetCount and 0xFFFFFFFFL)
        body.uint32(octetCount and 0xFFFFFFFFL)
        val bytes = body.build()

        // No reception reports: this end only sends.
        return header(senderReportType, 0, bytes.size) + bytes
    }

    fun sourceDescription(): ByteArray {
        val chunk = ByteBuilder()
        chunk.uint32(ssrc and 0xFFFFFFFFL)
        chunk.bytes(item(cnameItem, identity.cname))
        chunk.bytes(item(nameItem, identity.name))
        chunk.bytes(item(toolItem, "TS Cameraman"))
        // A single zero terminates the item list; the chunk then pads to a 4-byte boundary. There
        // must be at least one zero byte, so a chunk already on a boundary still gets four.
        val padding = 4 - (chunk.size % 4)
        chunk.bytes(ByteArray(padding))
        val bytes = chunk.build()

        return header(sourceDescriptionType, 1, bytes.size) + bytes
    }

    /**
     * The 4-byte RTCP header. `length` is in 32-bit words **minus one**, counting the header itself,
     * which is the off-by-one every hand-rolled RTCP writer gets wrong.
     */
    private fun header(type: Int, count: Int, bodyCount: Int): ByteArray {
        val data = ByteBuilder(4)
        data.byte(0x80 or (count and 0x1F))
        data.byte(type)
        data.uint16((4 + bodyCount) / 4 - 1)
        return data.build()
    }

    private fun item(type: Int, text: String): ByteArray {
        // The length field is a single byte, so an over-long name is truncated on a character
        // boundary rather than mid-UTF-8, which would make the item unparseable.
        var bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size > 255) {
            var truncated = text
            while (truncated.toByteArray(Charsets.UTF_8).size > 255) {
                truncated = truncated.substring(0, truncated.length - 1)
            }
            bytes = truncated.toByteArray(Charsets.UTF_8)
        }

        val data = ByteBuilder(2 + bytes.size)
        data.byte(type)
        data.byte(bytes.size)
        data.bytes(bytes)
        return data.build()
    }

    companion object {
        private const val senderReportType = 200
        private const val sourceDescriptionType = 202

        private const val cnameItem = 1
        private const val nameItem = 2
        private const val toolItem = 6

        /** Seconds since 1900 in the upper 32 bits, fraction in the lower, per RFC 3550 §4. */
        fun ntpTime(epochMillis: Long): Long {
            // 1900 to 1970 is 70 years including 17 leap days.
            val secondsFrom1900To1970 = 2_208_988_800.0
            val seconds = epochMillis / 1000.0 + secondsFrom1900To1970
            val whole = floor(seconds).toLong()
            val fraction = ((seconds - floor(seconds)) * 4_294_967_296.0).toLong()
            return (whole shl 32) or (fraction and 0xFFFFFFFFL)
        }
    }
}
