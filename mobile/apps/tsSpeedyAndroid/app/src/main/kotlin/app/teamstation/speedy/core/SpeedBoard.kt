package app.teamstation.speedy.core

/**
 * The two numbers on TS Speedy's screen. Each side holds its last reading above zero for five
 * seconds, then shows a dash; a side that never had a reading shows the dash too.
 */
data class SpeedBoard(val pitch: Slot? = null, val exit: Slot? = null) {
    data class Slot(val mph: Int, val atMs: Long)

    enum class Side { PITCH, EXIT }

    /**
     * A reading. Zero means "no reading" for that side, as it does on the wire. An exit always
     * comes after its own pitch, so a new pitch with no exit clears the exit before it: the board
     * never shows a pitch over another pitch's exit.
     */
    fun receive(pitch: Int, exit: Int, nowMs: Long): SpeedBoard = SpeedBoard(
        pitch = if (pitch > 0) Slot(pitch, nowMs) else this.pitch,
        exit = when {
            exit > 0 -> Slot(exit, nowMs)
            pitch > 0 -> null
            else -> this.exit
        }
    )

    /** When each side turns to the dash, earliest first: the readout redraws at these. */
    val expiries: List<Long> get() = listOfNotNull(pitch, exit).map { it.atMs + HOLD_MS }.sorted()

    fun text(side: Side, nowMs: Long): String {
        val slot = (if (side == Side.PITCH) pitch else exit) ?: return DASH
        return if (nowMs - slot.atMs < HOLD_MS) slot.mph.toString() else DASH
    }

    companion object {
        const val HOLD_MS = 5_000L
        const val DASH = "--"
    }
}
