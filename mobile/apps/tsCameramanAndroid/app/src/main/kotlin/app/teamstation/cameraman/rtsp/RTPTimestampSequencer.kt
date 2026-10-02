package app.teamstation.cameraman.rtsp

/**
 * Keeps the RTP timestamp this camera sends strictly advancing, without mistaking the field's own
 * rollover for a step backwards.
 *
 * Two frames sharing a timestamp are merged by the receiver into one malformed access unit, so a
 * capture clock that repeats a presentation time has to be nudged forward. Deciding that with a
 * plain `<=` breaks once the 32-bit field wraps — 13.3 hours at 90 kHz — because the wrapped value
 * is numerically tiny and every later frame then gets nudged by a single tick instead of a frame
 * interval, which collapses the whole timeline the receiver is asked to record against.
 *
 * Distances are therefore measured on the 32-bit circle, where the rollover is just another forward
 * step.
 */
class RTPTimestampSequencer {
    private var last: Long? = null

    val lastSent: Long? get() = last

    fun reset() {
        last = null
    }

    /** The timestamp to put on the wire for a frame whose own clock says [natural]. */
    fun next(natural: Long): Long {
        val value = natural and mask
        val previous = last
        if (previous == null) {
            last = value
            return value
        }
        val step = (value - previous) and mask
        // A step shorter than half the circle is the clock advancing; anything longer is the short
        // way back, which is a repeat or a reorder rather than 13 hours of progress in one frame.
        val sent = if (step == 0L || step > half) (previous + 1) and mask else value
        last = sent
        return sent
    }

    private companion object {
        const val mask = 0xFFFFFFFFL
        const val half = 1L shl 31
    }
}
