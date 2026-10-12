package app.teamstation.streamcore.stream

/**
 * The RTMP encoder's own timeline, independent of camera and replay clocks. A port of TS Director's
 * `StreamEncodeClock`.
 *
 * Live timestamps follow the wall clock, so dropped encodes cannot make the viewer fall behind, and
 * the clock never goes backwards: a frame at or before the last one goes a frame after it.
 */
class StreamEncodeClock(frameRate: Int = 30, gopSeconds: Double = 2.0) {
    val frameRate: Int = maxOf(frameRate, 1)
    val gopSeconds: Double = maxOf(gopSeconds, 0.1)

    var lastTime: MediaTime = MediaTime.negativeInfinity
        private set
    var lastKeyframeTime: MediaTime = MediaTime.negativeInfinity
        private set
    var lastKeyframeWall: Double = 0.0
        private set
    var awaitingKeyframe: Boolean = true
        private set
    var startWall: Double = 0.0
        private set

    val maxKeyFrameInterval: Int get() = maxOf(1, (frameRate * gopSeconds).roundedHalfAwayFromZero().toInt())

    fun reset() {
        lastTime = MediaTime.negativeInfinity
        lastKeyframeTime = MediaTime.negativeInfinity
        lastKeyframeWall = 0.0
        awaitingKeyframe = true
        startWall = 0.0
    }

    /** The next submitted frame must be an IDR. */
    fun requestKeyframe() {
        awaitingKeyframe = true
    }

    /**
     * Maps the next video frame onto a monotonic wall-clock encode timeline. The source time is
     * ignored, so camera timestamps cannot stall or rewind the live stream.
     */
    @Suppress("UNUSED_PARAMETER")
    fun nextPresentationTime(source: MediaTime, now: Double): MediaTime {
        if (startWall == 0.0) startWall = now
        val step = MediaTime(1, frameRate)
        var time = MediaTime.seconds(maxOf(0.0, now - startWall), 600)
        if (lastTime.isNumeric && time <= lastTime) time = lastTime + step
        lastTime = time
        return time
    }

    /** The same wall timeline as video, without advancing the last submitted video time. */
    fun timeNow(now: Double): MediaTime =
        if (startWall > 0) MediaTime.seconds(maxOf(0.0, now - startWall), 1000) else MediaTime.zero

    fun shouldForceKey(time: MediaTime, now: Double): Boolean {
        if (awaitingKeyframe) return true
        if (!lastKeyframeTime.isNumeric) return true
        if ((time - lastKeyframeTime).seconds >= gopSeconds) return true
        if (lastKeyframeWall > 0 && now - lastKeyframeWall >= gopSeconds) return true
        return false
    }

    fun noteKeyframe(time: MediaTime, now: Double) {
        lastKeyframeTime = time
        lastKeyframeWall = now
        awaitingKeyframe = false
    }

    /** Before the first keyframe, how long the stream has gone without one: since its first frame. */
    fun keyframeAgeSeconds(now: Double): Double =
        if (lastKeyframeWall > 0) maxOf(0.0, now - lastKeyframeWall)
        else if (startWall > 0) maxOf(0.0, now - startWall)
        else 0.0
}
