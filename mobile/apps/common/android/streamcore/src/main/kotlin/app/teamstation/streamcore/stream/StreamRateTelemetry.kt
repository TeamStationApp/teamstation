package app.teamstation.streamcore.stream

/**
 * The stream's bitrate controller as it last decided: where the rate is in the operator's range, why
 * it last moved, and what the link was doing when it did. TS Director's `StreamRateTelemetry`.
 */
data class StreamRateTelemetry(
    /** `hevc` or `h264`, empty while not streaming. */
    val codec: String = "",
    /** What the encoder has been told, in bits per second. */
    val bitrate: Int = 0,
    val low: Int = 0,
    val high: Int = 0,
    /** `hold`, `emergency`, `congested`, `growing` or `increase`. */
    val lastDecision: String = "",
    val queueMilliseconds: Int = 0,
    val deliveryBitsPerSecond: Int = 0,
    val transportBaseMilliseconds: Int = 0,
    val decreases: Int = 0,
    val increases: Int = 0
)
