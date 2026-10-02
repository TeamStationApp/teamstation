package app.teamstation.cameraman.rtsp

import app.teamstation.cameraman.core.EncodedVideoFrame
import kotlin.math.min

/**
 * RFC 6184 packetization: a NAL that fits goes out on its own, one that does not is split into FU-A
 * fragments.
 *
 * STAP-A aggregation is deliberately not used. It only saves packets on the parameter sets, and a
 * receiver that mishandles it produces a picture that looks decodable and is wrong.
 */
class H264Packetizer(
    private val maximumPayloadCount: Int = RTPLimits.defaultMaximumPayloadCount
) {
    /**
     * Returns the payloads for one access unit, in order. The caller sets the marker bit on the last
     * one and gives them all the same timestamp, which is what tells the receiver where the picture
     * ends.
     */
    fun payloads(frame: EncodedVideoFrame): List<ByteArray> =
        (frame.parameterSets + frame.nalUnits).flatMap { payloads(it) }

    fun payloads(nal: ByteArray): List<ByteArray> {
        if (nal.isEmpty()) return emptyList()
        if (nal.size <= maximumPayloadCount) return listOf(nal)

        // FU-A replaces the 1-byte NAL header with a 2-byte one, so each fragment carries that much
        // less.
        val bodyCount = maximumPayloadCount - 2
        if (bodyCount <= 0) return emptyList()

        val header = nal[0].toInt() and 0xFF
        val indicator = (header and 0xE0) or fuAType
        val type = header and 0x1F

        val payloads = ArrayList<ByteArray>()
        var offset = 1
        while (offset < nal.size) {
            val end = min(offset + bodyCount, nal.size)
            val isStart = offset == 1
            val isEnd = end == nal.size

            val fragment = ByteBuilder(2 + (end - offset))
            fragment.byte(indicator)
            fragment.byte((if (isStart) 0x80 else 0) or (if (isEnd) 0x40 else 0) or type)
            fragment.bytes(nal, offset, end - offset)
            payloads.add(fragment.build())

            offset = end
        }
        return payloads
    }

    companion object {
        /** The RTP clock for H.264 is fixed at 90 kHz by RFC 6184 §8.1, independent of frame rate. */
        const val clockRate: Long = 90_000

        private const val fuAType = 28
    }
}

object RTPLimits {
    /**
     * 1500-byte Ethernet MTU less 20 bytes of IPv4, 8 of UDP and 12 of RTP header.
     *
     * Interleaved RTSP rides on TCP where this does not strictly apply, but a stream that is also
     * deliverable over UDP without refragmenting is worth more than the few percent of overhead.
     */
    const val defaultMaximumPayloadCount = 1460
}
