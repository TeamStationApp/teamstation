package app.teamstation.streamcore.stream

/**
 * The counters the programme's encoders and its stream and recording controllers report. TS
 * Director's `MediaTelemetry`. Every method is called from whichever thread did the work, so an
 * implementation takes its own lock.
 */
interface MediaTelemetry {
    /** A compression session opened (+1) or closed (-1). */
    fun recordEncodeSessionChange(delta: Int)

    /** A keyframe went out on the stream, [ageSeconds] after the one before. */
    fun recordStreamKeyframe(ageSeconds: Double)

    /** How long since the stream's last keyframe. */
    fun recordStreamKeyframeAge(seconds: Double)

    /** Frames handed to the stream's encoder and not yet back. */
    fun recordStreamPendingEncodes(count: Int)

    /** How long since the stream's encoder last called back. */
    fun recordStreamEncodeCallbackAge(seconds: Double)

    /** How old the programme picture was when it reached the stream. */
    fun recordProgramFrameAge(seconds: Double)

    /** The stream's encoder went idle and a keyframe was forced to keep the stream alive. */
    fun recordStreamIdleKeyframe()

    /** The stream's encoder wedged and was rebuilt. */
    fun recordStreamEncoderReset()

    /** A compression session reported a failure. */
    fun recordEncodeFailure(code: Int)

    /** The programme master's finish, in words. */
    fun recordProgramFinish(detail: String)

    /** Something went wrong that is worth a line in the log. */
    fun recordError(message: String)

    /** The recording's last error, which a host shows the operator. */
    fun recordRecordingError(message: String)

    companion object {
        /** Telemetry that keeps nothing but the last words. */
        val None: MediaTelemetry = BasicMediaTelemetry()
    }
}

/**
 * Telemetry that keeps the last error, recording error and programme finish, and none of the counts.
 * A host that keeps more overrides what it keeps.
 */
open class BasicMediaTelemetry : MediaTelemetry {
    @Volatile
    var lastError: String? = null
        private set

    @Volatile
    var lastRecordingError: String? = null
        private set

    @Volatile
    var lastProgramFinish: String? = null
        private set

    override fun recordEncodeSessionChange(delta: Int) = Unit
    override fun recordStreamKeyframe(ageSeconds: Double) = Unit
    override fun recordStreamKeyframeAge(seconds: Double) = Unit
    override fun recordStreamPendingEncodes(count: Int) = Unit
    override fun recordStreamEncodeCallbackAge(seconds: Double) = Unit
    override fun recordProgramFrameAge(seconds: Double) = Unit
    override fun recordStreamIdleKeyframe() = Unit
    override fun recordStreamEncoderReset() = Unit
    override fun recordEncodeFailure(code: Int) = Unit

    override fun recordProgramFinish(detail: String) {
        lastProgramFinish = detail
    }

    override fun recordError(message: String) {
        lastError = message
    }

    override fun recordRecordingError(message: String) {
        lastRecordingError = message
    }
}
