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
    var codec: StreamCodec = StreamCodec.HEVC,
    /**
     * The operator's rate, and with [adaptiveBitrate] on, the ceiling: the stream runs at this and
     * comes down, never below [bitrateFloor], only while the link cannot carry it.
     */
    var bitrate: Int = StreamCodec.HEVC.defaultBitrate,
    /**
     * The lowest rate adaptation may reach, read only while [adaptiveBitrate] is on and never above
     * [bitrate]. Half the ceiling unless the operator chose otherwise: an operator who knows the
     * network can hold the picture higher, or let a weak link go lower before frames drop.
     */
    var bitrateFloor: Int = defaultBitrateFloor(bitrate),
    /**
     * Lower the rate while the link to a client backs up, instead of dropping frames at the full
     * rate. On by default; a softer picture for a few seconds beats a frozen one.
     */
    var adaptiveBitrate: Boolean = true,
    var port: Int = defaultPort,
    var path: String = canonicalPath,
    var audioEnabled: Boolean = true,
    /**
     * When false the encoder still runs, but every picture is black, so Director keeps a continuous
     * video clock — and live audio — instead of treating a hole as a missing camera.
     */
    var videoEnabled: Boolean = true,
    var audioSampleRate: Int = 48_000,
    /**
     * IDs of lenses the operator turned off. Empty means every detected lens is eligible, including
     * ones that appear on a later handset.
     */
    var disabledLensIDs: Set<String> = emptySet(),
    /**
     * Which camera the operator last framed with, and at what zoom. Persisted because a camera on a
     * tripod is aimed once: coming back on the wrong lens at 1x after a restart silently changes the
     * shot, and on a fixed rig nobody is standing there to notice.
     */
    var cameraPosition: CameraPosition = CameraPosition.BACK,
    var displayedZoom: Double = 1.0
) {
    // Every construction, `copy` included, so a copy that lowers the rate cannot leave the floor
    // above it.
    init {
        // A rate saved when the scale reached 50 Mbps comes back at the top of today's.
        if (bitrate > maximumBitrate) bitrate = maximumBitrate
        clampFloorToCeiling()
    }

    val dimensionsLabel: String get() = "${width}x$height"

    /**
     * Switching codec carries the matching default rate across unless the operator has already
     * chosen something other than the outgoing codec's default, and the default floor with it.
     *
     * Named `selectCodec` rather than the iOS build's `setCodec`, which on the JVM would be the
     * generated setter for `codec` and would silently replace it — assigning `settings.codec` would
     * then move the bitrate too, which is the opposite of what a plain assignment should do.
     */
    fun selectCodec(newCodec: StreamCodec) {
        if (bitrate == codec.defaultBitrate) selectBitrate(newCodec.defaultBitrate)
        codec = newCodec
    }

    /**
     * A new rate. A floor still at the old rate's default moves to the new rate's, so an operator who
     * never chose a floor keeps getting half of whatever they pick; a floor they did choose stays,
     * and comes down only when the rate now sits below it.
     *
     * The iOS build's `setBitrate`, named for the same reason as [selectCodec].
     */
    fun selectBitrate(requested: Int) {
        val newBitrate = minOf(requested, maximumBitrate)
        if (bitrateFloor == defaultBitrateFloor(bitrate)) bitrateFloor = defaultBitrateFloor(newBitrate)
        bitrate = newBitrate
        clampFloorToCeiling()
    }

    /**
     * Brings the floor down to the rate when it has been left above it: a floor over the ceiling
     * means nothing to the controller, and on screen it would read as a range turned inside out.
     */
    fun clampFloorToCeiling() {
        if (bitrateFloor > bitrate) bitrateFloor = bitrate
    }

    /**
     * The launch-argument names for each persisted field, which is how an explicit argument is told
     * apart from a value the operator last chose on the device.
     */
    enum class Field(val key: String) {
        CODEC("codec"),
        BITRATE_MBPS("bitrateMbps"),
        BITRATE_FLOOR_MBPS("bitrateFloorMbps"),
        ADAPTIVE_BITRATE("adaptiveBitrate"),
        WIDTH("width"),
        HEIGHT("height"),
        FRAME_RATE("frameRate"),
        AUDIO_ENABLED("audioEnabled"),
        RTSP_PORT("rtspPort"),
        RTSP_PATH("rtspPath"),
        DISABLED_LENSES("disabledLenses")
    }

    /**
     * What was saved on the device, laid over these launch defaults.
     *
     * Anything named in [explicit] is left alone: a flow that pins `codec h264` has to get H.264
     * whatever the operator last chose, or a UI test would depend on the state of the handset.
     *
     * [videoEnabled] is deliberately not carried across. It is the blanking control, not a
     * preference, and a camera left blank by a fault injection must come back showing a picture.
     */
    fun merging(saved: StreamSettings, explicit: Set<Field>): StreamSettings {
        val merged = copy()
        if (Field.CODEC !in explicit) merged.codec = saved.codec
        if (Field.BITRATE_MBPS !in explicit) merged.bitrate = saved.bitrate
        // A floor was chosen against its own ceiling. A launch that pins the rate and not the floor
        // gets the floor that goes with the pinned rate, not one saved against a different rate.
        if (Field.BITRATE_FLOOR_MBPS !in explicit && Field.BITRATE_MBPS !in explicit) {
            merged.bitrateFloor = saved.bitrateFloor
        }
        merged.clampFloorToCeiling()
        if (Field.ADAPTIVE_BITRATE !in explicit) merged.adaptiveBitrate = saved.adaptiveBitrate
        if (Field.WIDTH !in explicit) merged.width = saved.width
        if (Field.HEIGHT !in explicit) merged.height = saved.height
        if (Field.FRAME_RATE !in explicit) merged.frameRate = saved.frameRate
        if (Field.AUDIO_ENABLED !in explicit) merged.audioEnabled = saved.audioEnabled
        if (Field.RTSP_PORT !in explicit) merged.port = saved.port
        if (Field.RTSP_PATH !in explicit) merged.path = saved.path
        if (Field.DISABLED_LENSES !in explicit) merged.disabledLensIDs = saved.disabledLensIDs
        // Not launch arguments at all — the operator's last framing, which a flow never pins.
        merged.cameraPosition = saved.cameraPosition
        merged.displayedZoom = saved.displayedZoom
        return merged
    }

    companion object {
        const val canonicalPath = "/live/mainstream"

        /**
         * The one port every Cameraman serves on, Android and iPhone alike. Not the registered
         * 554: Linux — and therefore Android — refuses any port below 1024 to an unprivileged
         * process, and a Director sweep that probes one Cameraman port has to find both platforms
         * there.
         */
        const val defaultPort = 8554

        /**
         * What builds before the single port asked for. A saved 554 loads as [defaultPort], so the
         * stored request matches what the phone can actually bind.
         */
        const val retiredPort = 554

        /**
         * The lowest rate either end of the bitrate range may be set to, in the Settings sliders and
         * over the wire.
         */
        const val minimumBitrate = 1_000_000

        /**
         * The highest rate either end of the bitrate range may be set to, in the Settings sliders and
         * over the wire. A phone streams to one iPad over shared Wi-Fi, where more than this only
         * costs frames, and on a 1–16 scale an everyday 2–8 Mbps range is wide enough to see and drag.
         */
        const val maximumBitrate = 16_000_000

        /**
         * Half the ceiling, which is where the floor always sat before it was a setting, but not
         * below [minimumBitrate], and never above the ceiling itself.
         */
        fun defaultBitrateFloor(ceiling: Int): Int = minOf(ceiling, maxOf(minimumBitrate, ceiling / 2))

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
