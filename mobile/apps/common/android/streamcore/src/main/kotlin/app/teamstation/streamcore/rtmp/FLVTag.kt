package app.teamstation.streamcore.rtmp

import app.teamstation.streamcore.core.StreamCodec
import java.io.ByteArrayOutputStream

/**
 * The video codecs a publish carries, and how each is framed on the wire. A port of TS Director's
 * `RTMPVideoCodec`.
 *
 * H.264 goes out in classic FLV framing, codec ID 7. Classic FLV has no codec ID for H.265, so H.265
 * goes out in Enhanced RTMP (veovera/enhanced-rtmp, v1), which names the codec with a FourCC in an
 * extended tag header.
 */
enum class RTMPVideoCodec(val rawValue: String) {
    H264("h264"),
    HEVC("hevc");

    /** Enhanced RTMP's name for the codec, as `connect`'s `fourCcList` spells it. */
    val fourCCString: String
        get() = when (this) {
            H264 -> "avc1"
            HEVC -> "hvc1"
        }

    /** The same name as a big-endian number, as the tag header and `onMetaData` carry it. */
    val fourCC: Long get() = FLVTag.fourCC(fourCCString)

    /** Whether this codec travels in Enhanced RTMP's extended tag header rather than classic FLV. */
    val isEnhanced: Boolean get() = this == HEVC

    /** `onMetaData`'s `videocodecid`: 7 for H.264, and the FourCC read as a number for H.265. */
    val metadataCodecID: Double
        get() = when (this) {
            H264 -> 7.0
            HEVC -> fourCC.toDouble()
        }

    val displayName: String
        get() = when (this) {
            H264 -> "H.264"
            HEVC -> "H.265"
        }

    companion object {
        fun of(codec: StreamCodec): RTMPVideoCodec = when (codec) {
            StreamCodec.H264 -> H264
            StreamCodec.HEVC -> HEVC
        }
    }
}

/** FLV tag bodies for RTMP audio and video messages. A port of TS Director's `FLVTag`. */
object FLVTag {
    /** Enhanced RTMP's video packet types, carried in the low nibble of an extended header. */
    enum class EnhancedPacketType(val rawValue: Int) {
        /** The decoder configuration record: `hvcC` for H.265. */
        SEQUENCE_START(0),

        /** Coded pictures, preceded by a 24-bit composition time offset. */
        CODED_FRAMES(1),
        SEQUENCE_END(2),

        /** Coded pictures whose composition time offset is zero, which is therefore left out. */
        CODED_FRAMES_X(3),
        METADATA(4)
    }

    /** Classic FLV video: frame type and codec ID 7 (AVC), AVC packet type, composition time. */
    fun video(keyframe: Boolean, packetType: Int, compositionTime: Int = 0, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(5 + payload.size)
        val frameType = if (keyframe) 1 else 2
        out.write((frameType shl 4) or 7)
        out.write(packetType)
        appendSI24(compositionTime, out)
        out.write(payload)
        return out.toByteArray()
    }

    /** Enhanced RTMP video: `[IsExHeader:1][FrameType:3][PacketType:4]`, the FourCC, then the body. */
    fun enhancedVideo(
        keyframe: Boolean,
        packetType: EnhancedPacketType,
        fourCC: Long,
        compositionTime: Int = 0,
        payload: ByteArray
    ): ByteArray {
        val out = ByteArrayOutputStream(8 + payload.size)
        val frameType = if (keyframe) 1 else 2
        out.write(0x80 or (frameType shl 4) or packetType.rawValue)
        for (shift in 3 downTo 0) out.write(((fourCC ushr (shift * 8)) and 0xFF).toInt())
        if (packetType == EnhancedPacketType.CODED_FRAMES && (fourCC == fourCC("hvc1") || fourCC == fourCC("avc1"))) {
            appendSI24(compositionTime, out)
        }
        out.write(payload)
        return out.toByteArray()
    }

    /** The sequence header for [codec]: an AVC record in classic framing, or `hvcC` in a SequenceStart. */
    fun videoSequenceHeader(codec: RTMPVideoCodec, record: ByteArray): ByteArray =
        if (codec.isEnhanced) {
            enhancedVideo(true, EnhancedPacketType.SEQUENCE_START, codec.fourCC, payload = record)
        } else {
            video(keyframe = true, packetType = 0, payload = record)
        }

    /**
     * One coded picture. Frames are never reordered, so the composition time is always zero; H.265
     * still goes out as CodedFrames with its explicit zero, which is what OBS sends.
     */
    fun videoFrame(codec: RTMPVideoCodec, keyframe: Boolean, payload: ByteArray): ByteArray =
        if (codec.isEnhanced) {
            enhancedVideo(keyframe, EnhancedPacketType.CODED_FRAMES, codec.fourCC, payload = payload)
        } else {
            video(keyframe = keyframe, packetType = 1, payload = payload)
        }

    fun audio(packetType: Int, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(2 + payload.size)
        // AAC, 44 kHz flag (ignored for AAC), 16-bit, stereo.
        out.write(0xAF)
        out.write(packetType)
        out.write(payload)
        return out.toByteArray()
    }

    /** Whether a video tag is a decoder configuration record, in either framing. */
    fun isVideoSequenceHeader(tag: ByteArray): Boolean {
        if (tag.isEmpty()) return false
        val first = tag[0].toInt() and 0xFF
        if (first and 0x80 != 0) return first and 0x0F == EnhancedPacketType.SEQUENCE_START.rawValue
        return tag.size >= 2 && tag[1].toInt() == 0
    }

    /** AAC's packet type is the second byte, and 0 is the AudioSpecificConfig. */
    fun isAudioSequenceHeader(tag: ByteArray): Boolean = tag.size >= 2 && tag[1].toInt() == 0

    /** Frame type 1 is a keyframe in both framings. */
    fun isVideoKeyframe(tag: ByteArray): Boolean {
        if (tag.isEmpty()) return false
        val first = tag[0].toInt() and 0xFF
        val frameType = if (first and 0x80 != 0) (first ushr 4) and 0x07 else first ushr 4
        return frameType == 1
    }

    fun fourCC(code: String): Long =
        code.toByteArray(Charsets.US_ASCII).take(4).fold(0L) { acc, byte -> (acc shl 8) or (byte.toLong() and 0xFF) }

    fun avcDecoderConfigurationRecord(sps: ByteArray, pps: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(1)
        if (sps.size >= 4) {
            out.write(sps, 1, 3)
        } else {
            out.write(byteArrayOf(0x64, 0x00, 0x1F))
        }
        out.write(0xFF)
        out.write(0xE1)
        out.write((sps.size ushr 8) and 0xFF)
        out.write(sps.size and 0xFF)
        out.write(sps)
        out.write(1)
        out.write((pps.size ushr 8) and 0xFF)
        out.write(pps.size and 0xFF)
        out.write(pps)
        return out.toByteArray()
    }

    private fun appendSI24(value: Int, out: ByteArrayOutputStream) {
        val bits = value and 0xFFFFFF
        out.write((bits ushr 16) and 0xFF)
        out.write((bits ushr 8) and 0xFF)
        out.write(bits and 0xFF)
    }
}
