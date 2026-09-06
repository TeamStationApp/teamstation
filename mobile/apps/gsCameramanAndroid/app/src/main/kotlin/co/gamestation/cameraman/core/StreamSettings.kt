package co.gamestation.cameraman.core

enum class StreamCodec(val rawValue: String) {
    H264("h264"),
    HEVC("hevc");

    /**
     * The SDP encoding name. `H265` rather than `HEVC` because that is what GS Producer's
     * `SDPDescription.videoCodec` matches first, and what ffmpeg and VLC expect.
     */
    val sdpEncodingName: String
        get() = when (this) {
            H264 -> "H264"
            HEVC -> "H265"
        }

    /** HEVC buys roughly the same picture at two thirds the rate, so the defaults differ. */
    val defaultBitrate: Int
        get() = when (this) {
            H264 -> 6_000_000
            HEVC -> 4_000_000
        }

    val displayName: String
        get() = when (this) {
            H264 -> "H.264"
            HEVC -> "HEVC"
        }

    /** The MediaCodec MIME the encoder is created from. */
    val mimeType: String
        get() = when (this) {
            H264 -> "video/avc"
            HEVC -> "video/hevc"
        }

    companion object {
        fun fromRawValue(value: String): StreamCodec? =
            entries.firstOrNull { it.rawValue == value.lowercase() }
    }
}

/** Everything the operator can change about the outgoing stream. */
data class StreamSettings(
    var width: Int = 1920,
    var height: Int = 1080,
    var frameRate: Double = 30.0,
    var codec: StreamCodec = StreamCodec.H264,
    var bitrate: Int = 6_000_000,
    var port: Int = defaultPort,
    var path: String = canonicalPath,
    var audioEnabled: Boolean = true,
    var audioSampleRate: Int = 48_000
) {
    val dimensionsLabel: String get() = "${width}x$height"

    /**
     * Switching codec carries the matching default rate across unless the operator has already
     * chosen something other than the outgoing codec's default.
     *
     * Named `selectCodec` rather than the iOS build's `setCodec`, which on the JVM would be the
     * generated setter for `codec` and would silently replace it — assigning `settings.codec` would
     * then move the bitrate too, which is the opposite of what a plain assignment should do.
     */
    fun selectCodec(newCodec: StreamCodec) {
        if (bitrate == codec.defaultBitrate) bitrate = newCodec.defaultBitrate
        codec = newCodec
    }

    companion object {
        const val canonicalPath = "/live/mainstream"

        /**
         * 554 is the registered RTSP port and what every client tries first, so it stays the
         * request. Unlike iOS, Linux — and therefore Android — refuses to let an unprivileged
         * process bind below 1024, so on a handset this *always* falls through to the fallback.
         * Asking anyway is not pointless: the attempt is what makes the fallback visible on screen
         * and in the status dump instead of a silently different port.
         */
        const val defaultPort = 554
        const val fallbackPort = 8554

        val default = StreamSettings()
    }
}

/**
 * One capture format, reduced to the facts that decide whether it is usable.
 *
 * A plain value type rather than a `CameraCharacteristics` stream configuration so the selection
 * rules can be tested without a camera, which matters because a JVM unit test has none.
 */
data class CaptureFormatDescriptor(
    val width: Int,
    val height: Int,
    val minimumFrameRate: Double,
    val maximumFrameRate: Double,
    /**
     * False when selecting this format collapses the logical device to a single lens. On Android
     * the high-speed (slow-motion) configurations are the ones that do this, and losing lens
     * switching silently would remove the app's headline feature.
     */
    val supportsMultiLensSwitching: Boolean,
    val isBinned: Boolean = false
) {
    val pixelCount: Int get() = width * height
    val label: String get() = "${width}x$height@${maximumFrameRate.toInt()}"

    fun supports(frameRate: Double): Boolean =
        frameRate >= minimumFrameRate - 0.01 && frameRate <= maximumFrameRate + 0.01
}
