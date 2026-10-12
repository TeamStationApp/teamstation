package app.teamstation.streamcore.stream

/**
 * Admits programme frames into the stream encoder at the stream's configured rate. A port of TS
 * Director's `StreamFramePacer`.
 *
 * Frames are due one interval after the last one admitted, and a quarter of an interval early still
 * counts, so 60 fps with ordinary jitter yields a steady 30. After a stall the cadence restarts from
 * the next frame instead of admitting a burst to catch up.
 */
class StreamFramePacer(frameRate: Int) {
    val interval: Double = 1.0 / maxOf(frameRate, 1)
    private var nextDue: Double? = null

    fun admit(now: Double): Boolean {
        val due = nextDue
        if (due == null) {
            nextDue = now + interval
            return true
        }
        if (now < due - interval / 4) return false
        nextDue = if (now - due > interval) now + interval else due + interval
        return true
    }

    fun reset() {
        nextDue = null
    }
}
