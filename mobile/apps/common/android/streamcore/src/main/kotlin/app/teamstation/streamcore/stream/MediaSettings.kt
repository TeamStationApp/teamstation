package app.teamstation.streamcore.stream

import app.teamstation.streamcore.core.StreamCodec

/**
 * How the programme stream is encoded: the values [ProgramStreamer] opens a session with. The
 * bitrate starts at [bitrateStart] ([bitrateHigh] when that is null) and moves between the low and
 * the high with the uplink. TS Director's `StreamSettings`.
 */
data class StreamSettings(
    val codec: StreamCodec = StreamCodec.HEVC,
    val width: Int = 1920,
    val height: Int = 1080,
    val frameRate: Int = 30,
    val bitrateLow: Int = 500_000,
    val bitrateHigh: Int = 4_000_000,
    val gopSeconds: Double = 2.0,
    /**
     * Where a session opens, below the high when the uplink is not known yet: a phone's starts at
     * half its high rather than at the top of a link it has never measured. Null opens at the high,
     * as TS Director's stream always has.
     */
    val bitrateStart: Int? = null
) {
    /** The rate a session opens at: [bitrateStart] held between the low and the high, or the high. */
    val openingBitrate: Int
        get() = bitrateStart?.let { minOf(maxOf(bitrateLow, it), bitrateHigh) } ?: bitrateHigh
}
