package co.gamestation.cameraman.rtsp

import co.gamestation.cameraman.core.EncodedVideoFrame
import kotlin.math.min

/**
 * RFC 7798 packetization.
 *
 * Kept separate from the H.264 version on purpose: the NAL header is two bytes, the type sits in
 * different bits, the fragmentation type is 49 rather than 28, and the start/end bits live in a
 * third byte. Sharing the code would make each of those a silent wrong-picture bug.
 */
class HEVCPacketizer(
    private val maximumPayloadCount: Int = RTPLimits.defaultMaximumPayloadCount
) {
    fun payloads(frame: EncodedVideoFrame): List<ByteArray> =
        (frame.parameterSets + frame.nalUnits).flatMap { payloads(it) }

    fun payloads(nal: ByteArray): List<ByteArray> {
        if (nal.size < 2) return emptyList()
        if (nal.size <= maximumPayloadCount) return listOf(nal)

        // The fragment carries a 2-byte payload header plus a 1-byte FU header, replacing the 2-byte
        // NAL header, so it costs one byte more than the original per fragment.
        val bodyCount = maximumPayloadCount - 3
        if (bodyCount <= 0) return emptyList()

        val first = nal[0].toInt() and 0xFF
        val second = nal[1].toInt() and 0xFF
        val type = (first shr 1) and 0x3F
        // Keep the forbidden-zero bit and the layer id, substitute the fragmentation type.
        val payloadHeaderFirst = (first and 0x81) or (fragmentationType shl 1)

        val payloads = ArrayList<ByteArray>()
        var offset = 2
        while (offset < nal.size) {
            val end = min(offset + bodyCount, nal.size)
            val isStart = offset == 2
            val isEnd = end == nal.size

            val fragment = ByteBuilder(3 + (end - offset))
            fragment.byte(payloadHeaderFirst)
            fragment.byte(second)
            fragment.byte((if (isStart) 0x80 else 0) or (if (isEnd) 0x40 else 0) or type)
            fragment.bytes(nal, offset, end - offset)
            payloads.add(fragment.build())

            offset = end
        }
        return payloads
    }

    companion object {
        const val clockRate: Long = 90_000

        private const val fragmentationType = 49
    }
}
