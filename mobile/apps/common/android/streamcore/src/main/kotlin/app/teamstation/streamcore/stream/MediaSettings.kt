package app.teamstation.streamcore.stream

import app.teamstation.streamcore.core.StreamCodec

/**
 * How the programme stream is encoded: the values [ProgramStreamer] opens a session with. The
 * bitrate starts at [bitrateHigh] and moves between the two with the uplink. TS Director's
 * `StreamSettings`.
 */
data class StreamSettings(
    val codec: StreamCodec = StreamCodec.HEVC,
    val width: Int = 1920,
    val height: Int = 1080,
    val frameRate: Int = 30,
    val bitrateLow: Int = 500_000,
    val bitrateHigh: Int = 4_000_000,
    val gopSeconds: Double = 2.0
)
