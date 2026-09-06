package co.gamestation.cameraman.rtsp

/**
 * RTSP interleaved framing, RFC 2326 §10.12: `$ <channel> <16-bit big-endian length> <payload>`.
 *
 * Channel assignment follows what GS Producer's `RTSPSession` requests: video on 0 with its RTCP
 * on 1, audio on 2 with its RTCP on 3. The client discards odd channels, but the sender reports
 * still have to go out — ffmpeg and VLC use them for A/V sync, and they carry the SDES CNAME.
 */
object InterleavedChannel {
    const val video = 0
    const val videoControl = 1
    const val audio = 2
    const val audioControl = 3
}

object InterleavedFramer {
    /** The largest payload a single frame can carry. RTP packets are budgeted well below this. */
    const val maximumPayloadSize = 0xFFFF

    fun frame(channel: Int, payload: ByteArray): ByteArray? {
        if (payload.size > maximumPayloadSize) return null
        val result = ByteBuilder(payload.size + 4)
        result.byte(0x24)
        result.byte(channel)
        result.byte((payload.size shr 8) and 0xFF)
        result.byte(payload.size and 0xFF)
        result.bytes(payload)
        return result.build()
    }

    fun frames(channel: Int, payloads: List<ByteArray>): ByteArray {
        val result = ByteBuilder()
        for (payload in payloads) {
            frame(channel, payload)?.let { result.bytes(it) }
        }
        return result.build()
    }
}
