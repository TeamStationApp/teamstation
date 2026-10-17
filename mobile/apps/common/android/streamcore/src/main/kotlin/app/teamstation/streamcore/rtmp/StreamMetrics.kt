package app.teamstation.streamcore.rtmp

import kotlin.math.round

/** A port of TS Director's `StreamMetrics`. */
object StreamMetrics {
    /** Bytes on the wire over [windowSeconds], as megabits/s rounded to 0.01. */
    fun megabits(bytes: Long, windowSeconds: Double): Double {
        if (windowSeconds <= 0) return 0.0
        val megabits = bytes.toDouble() * 8 / 1_000_000 / windowSeconds
        return round(megabits * 100) / 100
    }
}

/** Presents each distinct stream error once per session, so a failing send loop cannot stack them. */
class StreamErrorGate {
    private var shown: String? = null

    fun reset() {
        shown = null
    }

    fun shouldPresent(message: String): Boolean {
        if (shown == message) return false
        shown = message
        return true
    }
}
