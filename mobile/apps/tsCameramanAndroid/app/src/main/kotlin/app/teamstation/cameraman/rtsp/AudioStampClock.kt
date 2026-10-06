package app.teamstation.cameraman.rtsp

import kotlin.math.roundToLong

/**
 * The audio RTP timestamp from where each frame's samples were captured, not from how many frames
 * went before.
 *
 * Counting frames from zero made every stamp after a microphone dropout early by the samples the
 * microphone lost, until the next sender report revealed it as a jump. Here a frame's stamp is its
 * sample position since the session's first frame: within a run frames are exactly
 * [samplesPerFrame] apart whatever jitter the capture times carry, and when capture says more than
 * half a frame was lost the stamp skips forward by what was lost. A stamp never goes backwards.
 * The same rule as TS Cameraman on iOS.
 */
internal class AudioStampClock(private val sampleRate: Double, private val samplesPerFrame: Long = 1024) {
    private var firstCapture: Double? = null
    private var position = 0L

    /** Samples skipped over for dropouts since the session began. */
    var skippedSamples = 0L
        private set

    /** Dropouts skipped over since the session began. */
    var gaps = 0
        private set

    companion object {
        /**
         * How much later than the capture clock says this phone's sound was heard, against the
         * pictures captured with it. Added to every sound capture time before it is stamped and
         * reported, so a receiver placing sound and pictures by capture time puts them together.
         * Measured on a Pixel 10 by Big Time's clap/flash through TS Director: the sound sat 25 ms
         * ahead of the picture (31 ms live, 19 ms recorded), with AAC priming already allowed for.
         */
        const val captureTrimSeconds = 0.025
    }

    /** The stamp for a frame whose first sample was captured at [capture] seconds. */
    fun next(capture: Double): Long {
        val first = firstCapture
        if (first == null) {
            firstCapture = capture
            position = 0
            return 0
        }
        val expected = position + samplesPerFrame
        val captured = ((capture - first) * sampleRate).roundToLong()
        val lost = captured - expected
        position = if (lost > samplesPerFrame / 2) {
            skippedSamples += lost
            gaps += 1
            captured
        } else {
            expected
        }
        return position and 0xFFFFFFFFL
    }
}

/**
 * When a stream's sender report goes out: ahead of the first packet of a session, so a receiver can
 * place the very first sound and picture it gets, and then about once a second.
 */
internal class SenderReportSchedule {
    private var sentThisSession = false
    private var lastMillis = Long.MIN_VALUE / 2

    fun reset() {
        sentThisSession = false
    }

    /** True for a session's first packet: its report goes out before it. */
    fun reportBeforeFirstPacket(nowMillis: Long): Boolean {
        if (sentThisSession) return false
        sentThisSession = true
        lastMillis = nowMillis
        return true
    }

    /** True when a second has passed since the last report. */
    fun reportIsDue(nowMillis: Long): Boolean {
        if (nowMillis - lastMillis < 1000) return false
        lastMillis = nowMillis
        return true
    }
}
