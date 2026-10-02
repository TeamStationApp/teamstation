package app.teamstation.cameraman.rtsp

/**
 * Serializes the 12-byte RTP header defined in RFC 3550 §5.1.
 *
 * No contributing sources, no header extension and no padding, which is what every packetizer here
 * wants and what keeps the header a fixed size.
 */
class RTPPacketWriter(private val payloadType: Int, private val ssrc: Long) {

    fun packet(
        sequenceNumber: Int,
        timestamp: Long,
        marker: Boolean,
        payload: ByteArray
    ): ByteArray {
        val builder = ByteBuilder(headerCount + payload.size)
        // Version 2, no padding, no extension, no contributing sources.
        builder.byte(0x80)
        builder.byte(if (marker) (payloadType or 0x80) else (payloadType and 0x7F))
        builder.uint16(sequenceNumber and 0xFFFF)
        builder.uint32(timestamp and 0xFFFFFFFFL)
        builder.uint32(ssrc and 0xFFFFFFFFL)
        builder.bytes(payload)
        return builder.build()
    }

    companion object {
        const val headerCount = 12
    }
}
