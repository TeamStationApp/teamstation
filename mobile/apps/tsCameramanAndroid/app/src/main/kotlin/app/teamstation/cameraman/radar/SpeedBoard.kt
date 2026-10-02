package app.teamstation.cameraman.radar

data class SpeedSlot(val mph: Int, val atMs: Long)

/**
 * Pitch and exit each hold their last nonzero reading for five seconds.
 * [clockMs] is the clock [visible] uses while a uiTest feed is suppressing the wall clock.
 */
data class SpeedBoard(
    val pitch: SpeedSlot? = null,
    val exit: SpeedSlot? = null,
    val clockMs: Long = 0L
) {
    fun receive(pitchMph: Int, exitMph: Int, now: Long): SpeedBoard {
        return copy(
            pitch = if (pitchMph > 0) SpeedSlot(pitchMph, now) else pitch,
            exit = if (exitMph > 0) SpeedSlot(exitMph, now) else exit,
            clockMs = now
        )
    }

    fun visible(now: Long = clockMs, holdMs: Long = HOLD_MS): String {
        return side(pitch, now, holdMs) + "/" + side(exit, now, holdMs)
    }

    private fun side(slot: SpeedSlot?, now: Long, holdMs: Long): String {
        if (slot == null) return DASH
        return if (now - slot.atMs < holdMs) slot.mph.toString() else DASH
    }

    companion object {
        const val HOLD_MS = 5_000L
        const val DASH = "–"
    }
}
