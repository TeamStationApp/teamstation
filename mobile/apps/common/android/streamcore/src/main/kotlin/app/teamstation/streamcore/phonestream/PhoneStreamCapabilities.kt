package app.teamstation.streamcore.phonestream

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat

/** What the bridge's `capabilities()` answers: whether this phone can record video, and its name. */
data class PhoneCapabilities(val supported: Boolean, val deviceModel: String)

/**
 * Whether this phone can stream and record: it needs an HEVC encoder that can code 1920×1080 at
 * 30 fps. Phones without one do not offer Record video.
 */
object PhoneStreamCapabilities {
    /** One video encoder the phone has, and whether it codes the profile's picture at its rate. */
    data class Encoder(val name: String, val mimeType: String, val codes1080p30: Boolean)

    val isSupported: Boolean get() = isSupported(systemEncoders())

    fun current(): PhoneCapabilities = PhoneCapabilities(isSupported, DeviceModelName.current)

    fun isSupported(encoders: List<Encoder>): Boolean =
        encoders.any { it.mimeType.equals(MediaFormat.MIMETYPE_VIDEO_HEVC, ignoreCase = true) && it.codes1080p30 }

    /** Every HEVC encoder on the phone, read from `MediaCodecList`. */
    fun systemEncoders(): List<Encoder> = runCatching {
        MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
            .filter { it.isEncoder }
            .flatMap { info ->
                info.supportedTypes
                    .filter { it.equals(MediaFormat.MIMETYPE_VIDEO_HEVC, ignoreCase = true) }
                    .map { type -> Encoder(info.name, type, codes1080p30(info, type)) }
            }
    }.getOrDefault(emptyList())

    private fun codes1080p30(info: MediaCodecInfo, type: String): Boolean {
        val video = runCatching { info.getCapabilitiesForType(type).videoCapabilities }.getOrNull() ?: return false
        val (width, height, rate) = Triple(PhoneStreamProfile.width, PhoneStreamProfile.height, PhoneStreamProfile.frameRate.toDouble())
        return runCatching { video.areSizeAndRateSupported(width, height, rate) || video.areSizeAndRateSupported(height, width, rate) }
            .getOrDefault(false)
    }
}
