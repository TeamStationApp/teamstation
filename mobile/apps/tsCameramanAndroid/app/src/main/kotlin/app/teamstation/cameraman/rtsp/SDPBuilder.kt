package app.teamstation.cameraman.rtsp

import app.teamstation.cameraman.core.DeviceIdentity
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.encode.AudioSpecificConfigBuilder
import app.teamstation.streamcore.encode.ParameterSets

/**
 * Builds the session description returned by `DESCRIBE`.
 *
 * The decoder configuration goes in here as well as in-band, because a client that waits for the
 * in-band copy shows nothing until the next keyframe.
 */
class SDPBuilder(
    private val identity: DeviceIdentity,
    private val video: VideoTrack,
    private val audio: AudioTrack?,
    private val videoSSRC: Long,
    private val audioSSRC: Long
) {
    data class VideoTrack(
        val codec: StreamCodec,
        val parameterSets: List<ByteArray>,
        val width: Int,
        val height: Int
    )

    data class AudioTrack(
        val audioSpecificConfig: ByteArray,
        val sampleRate: Int,
        val channelCount: Int
    ) {
        override fun equals(other: Any?): Boolean =
            other is AudioTrack &&
                other.audioSpecificConfig.contentEquals(audioSpecificConfig) &&
                other.sampleRate == sampleRate &&
                other.channelCount == channelCount

        override fun hashCode(): Int {
            var result = audioSpecificConfig.contentHashCode()
            result = result * 31 + sampleRate
            return result * 31 + channelCount
        }
    }

    /** CRLF-terminated, per RFC 4566 §5. Some clients tolerate bare LF; VLC and ffmpeg want CRLF. */
    fun build(): String {
        val lines = mutableListOf(
            "v=0",
            // A zero address with a zero network type is the standard "unicast, address unknown"
            // form; the transport is settled by SETUP, not here.
            "o=- 0 0 IN IP4 0.0.0.0",
            "s=${identity.name}",
            "t=0 0",
            "a=tool:TS Cameraman",
            "a=control:*",
            "a=range:npt=now-",
            // Live capture has no seek, and a client that thinks otherwise sends a PLAY with a Range
            // it cannot get.
            "a=type:broadcast"
        )

        lines.addAll(videoLines())
        audio?.let { lines.addAll(audioLines(it)) }

        return lines.joinToString("\r\n") + "\r\n"
    }

    private fun videoLines(): List<String> {
        val lines = mutableListOf(
            "m=video 0 RTP/AVP $videoPayloadType",
            "c=IN IP4 0.0.0.0",
            "a=rtpmap:$videoPayloadType ${video.codec.sdpEncodingName}/${H264Packetizer.clockRate}",
            "a=control:$videoTrackControl"
        )

        when (video.codec) {
            StreamCodec.H264 -> {
                // Comma-separated base64, SPS then PPS.
                val sets = video.parameterSets.joinToString(",") { base64(it) }
                val parameters = mutableListOf("packetization-mode=1", "sprop-parameter-sets=$sets")
                // profile-level-id is what a client uses to decide whether it can decode the stream
                // at all, and it has to agree with the SPS or the decision is made on the wrong
                // numbers.
                val sps = video.parameterSets.firstOrNull()
                val profileLevelID = sps?.let { ParameterSets.h264ProfileLevelID(it) }
                if (profileLevelID != null) {
                    parameters.add(0, "profile-level-id=$profileLevelID")
                }
                lines.add("a=fmtp:$videoPayloadType ${parameters.joinToString("; ")}")
            }
            StreamCodec.HEVC -> {
                // Separate attributes in VPS, SPS, PPS order, which is the order the receiver has to
                // feed them to the decoder.
                val names = listOf("sprop-vps", "sprop-sps", "sprop-pps")
                val parameters = names.zip(video.parameterSets)
                    .map { (name, set) -> "$name=${base64(set)}" }
                if (parameters.isNotEmpty()) {
                    lines.add("a=fmtp:$videoPayloadType ${parameters.joinToString("; ")}")
                }
            }
        }

        lines.add("a=framesize:$videoPayloadType ${video.width}-${video.height}")
        lines.addAll(identityLines(videoSSRC))
        return lines
    }

    /**
     * RFC 5576 §6.1. These must be the same strings the RTCP SDES CNAME and NAME carry, which is why
     * both read `identity`. A client can label the camera from the DESCRIBE alone, without waiting
     * for the first RTCP packet.
     */
    private fun identityLines(ssrc: Long): List<String> = listOf(
        "a=ssrc:$ssrc cname:${identity.cname}",
        "a=ssrc:$ssrc name:${identity.name}"
    )

    private fun audioLines(audio: AudioTrack): List<String> {
        val rtpmap = "$audioPayloadType mpeg4-generic/${audio.sampleRate}/${audio.channelCount}"
        val parameters = listOf(
            "profile-level-id=1",
            "mode=AAC-hbr",
            "sizelength=${AACPacketizer.sizeLength}",
            "indexlength=${AACPacketizer.indexLength}",
            "indexdeltalength=${AACPacketizer.indexDeltaLength}",
            "config=${AudioSpecificConfigBuilder.hex(audio.audioSpecificConfig)}"
        )

        return listOf(
            "m=audio 0 RTP/AVP $audioPayloadType",
            "c=IN IP4 0.0.0.0",
            "a=rtpmap:$rtpmap",
            "a=control:$audioTrackControl",
            "a=fmtp:$audioPayloadType ${parameters.joinToString("; ")}"
        ) + identityLines(audioSSRC)
    }

    /**
     * `java.util.Base64` rather than `android.util.Base64`: the platform one is a stub in a JVM
     * unit-test process and would hand every SDP test an empty `sprop-parameter-sets` that still
     * looked like a valid line. The JDK encoder is unwrapped by default, which matters — a wrapped
     * SPS would split the attribute across two SDP lines and a client would read a truncated
     * parameter set followed by a malformed attribute.
     */
    private fun base64(data: ByteArray): String =
        java.util.Base64.getEncoder().encodeToString(data)

    companion object {
        /**
         * Dynamic payload types from the 96–127 range. Fixed rather than negotiated, which is what
         * every camera this pipeline talks to does.
         */
        const val videoPayloadType = 96
        const val audioPayloadType = 97

        const val videoTrackControl = "trackID=0"
        const val audioTrackControl = "trackID=1"
    }
}
