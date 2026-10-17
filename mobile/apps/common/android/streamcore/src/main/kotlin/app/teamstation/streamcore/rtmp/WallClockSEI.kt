package app.teamstation.streamcore.rtmp

/**
 * The wall clock a frame carries in its own bitstream: when its picture was taken, on TeamStation's
 * clock when the phone had measured the difference and on its own otherwise. A port of TS Director's
 * `WallClockSEI` (DirectorCore), byte for byte: TeamStation reads the same message
 * (`src/common/wallClockSei.ts`), and all three check the vectors in
 * `src/test/wallClockSeiVectors.json`.
 *
 * Every copy the server makes of a stream is `-c copy` (the RTMP ingest, the live HLS, the recording
 * it becomes), so a frame stamped here keeps its moment all the way to a viewer, across an outage and
 * a reconnect, where the RTMP timestamps start again. TeamStation places a publish by it, and a
 * player draws the scoreboard in effect at the frame on screen.
 *
 * It is a `user_data_unregistered` SEI message (payload type 5): NAL type 6 for H.264, prefix SEI
 * (NAL type 39) for HEVC. Its payload is 16 bytes of [UUID], a version byte, the wall in milliseconds
 * since 1970 as a signed big-endian 64-bit integer, and a flags byte whose bit 0 says the clock is
 * the server's.
 */
object WallClockSEI {
    /** Ours, and nobody else's: `5e2f0c4a-7d1b-4b6e-9c38-1f0a6d2e8b71`. */
    val UUID: ByteArray = byteArrayOf(
        0x5E, 0x2F, 0x0C, 0x4A, 0x7D, 0x1B, 0x4B, 0x6E,
        0x9C.toByte(), 0x38, 0x1F, 0x0A, 0x6D, 0x2E, 0x8B.toByte(), 0x71
    )
    const val VERSION: Int = 1

    /** `user_data_unregistered`. */
    const val PAYLOAD_TYPE: Int = 5

    /** UUID, version, wall ms and flags. */
    const val PAYLOAD_SIZE: Int = 16 + 1 + 8 + 1

    /** The SEI NAL type in each codec: H.264's SEI, HEVC's prefix SEI. */
    fun seiNalType(codec: RTMPVideoCodec): Int = when (codec) {
        RTMPVideoCodec.H264 -> 6
        RTMPVideoCodec.HEVC -> 39
    }

    /**
     * Whether a NAL unit, by its first header byte, is a coded slice: part of the frame's picture,
     * which every SEI of the frame has to come before. H.264's slices are types 1 to 5; every HEVC
     * type below 32 is a VCL unit.
     */
    fun isSlice(codec: RTMPVideoCodec, header: Byte): Boolean {
        val value = header.toInt() and 0xFF
        return when (codec) {
            RTMPVideoCodec.H264 -> (value and 0x1F) in 1..5
            RTMPVideoCodec.HEVC -> (value ushr 1) and 0x3F < 32
        }
    }

    /**
     * The stamp as one NAL unit: header, the SEI message and its trailing bits, with emulation
     * prevention applied. No start code and no length prefix, which are the container's.
     */
    fun encode(codec: RTMPVideoCodec, wallMs: Long, corrected: Boolean): ByteArray {
        // One message: type and size each fit in one byte, then the payload and the stop bit that
        // ends the RBSP.
        val rbsp = ByteArray(2 + PAYLOAD_SIZE + 1)
        rbsp[0] = PAYLOAD_TYPE.toByte()
        rbsp[1] = PAYLOAD_SIZE.toByte()
        UUID.copyInto(rbsp, 2)
        rbsp[18] = VERSION.toByte()
        for (index in 0 until 8) rbsp[19 + index] = (wallMs ushr (56 - index * 8)).toByte()
        rbsp[27] = if (corrected) 1 else 0
        rbsp[28] = 0x80.toByte()
        val header = when (codec) {
            RTMPVideoCodec.H264 -> byteArrayOf(seiNalType(codec).toByte())
            // nuh_layer_id 0, nuh_temporal_id_plus1 1.
            RTMPVideoCodec.HEVC -> byteArrayOf((seiNalType(codec) shl 1).toByte(), 0x01)
        }
        return header + addEmulationPrevention(rbsp)
    }

    /**
     * Inserts `03` after every two zero bytes that a byte of 3 or less follows, so nothing inside the
     * unit reads as a start code. A wall in this century always needs one: the version byte's `01` is
     * followed by the wall's two leading zero bytes and then `01`.
     */
    fun addEmulationPrevention(rbsp: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream(rbsp.size + rbsp.size / 2)
        var zeros = 0
        for (byte in rbsp) {
            val value = byte.toInt() and 0xFF
            if (zeros >= 2 && value <= 3) {
                out.write(3)
                zeros = 0
            }
            out.write(value)
            zeros = if (value == 0) zeros + 1 else 0
        }
        return out.toByteArray()
    }
}

/**
 * When a frame's picture was taken, as the wall-clock SEI it goes out with says: a port of TS
 * Director's `FrameWallClock` (DirectorRTMP).
 *
 * The stream hands over its own reading of the frame's wall clock and the server clock offset the
 * phone last measured; this puts the two together. With an offset the frame is on TeamStation's clock
 * and says so (bit 0 of the SEI's flags). Without one it carries the phone's own wall clock with the
 * bit clear, which the server takes as approximate: still frame-exact against itself, just not against
 * the scoring.
 */
data class FrameWallClock(
    /** When the picture was captured, in milliseconds since 1970 on the phone's wall clock. */
    val contentWallMs: Long,
    /** TeamStation's clock less the phone's, in milliseconds, or null when it has not been measured. */
    val serverClockOffsetMs: Int?
) {
    /** The wall the SEI carries: on the server's clock when the offset is known. */
    val wallMs: Long get() = contentWallMs + (serverClockOffsetMs ?: 0)

    /** Whether the wall has been moved onto the server's clock. */
    val corrected: Boolean get() = serverClockOffsetMs != null

    /**
     * [nalUnits], one frame's units without length prefixes, with this frame's SEI inserted after
     * whatever comes before the first slice and so ahead of the picture, where every SEI of an access
     * unit belongs. Units with no slice get it at the end.
     */
    fun inserted(nalUnits: List<ByteArray>, codec: RTMPVideoCodec): List<ByteArray> {
        val sei = WallClockSEI.encode(codec, wallMs, corrected)
        val at = nalUnits.indexOfFirst { it.isNotEmpty() && WallClockSEI.isSlice(codec, it[0]) }
            .let { if (it < 0) nalUnits.size else it }
        return nalUnits.subList(0, at) + listOf(sei) + nalUnits.subList(at, nalUnits.size)
    }
}
