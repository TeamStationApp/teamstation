package app.teamstation.streamcore.phonestream

/**
 * The capture time a programme frame carries: its picture's, for a picture new to the programme, and
 * for the same picture shown again, that capture time plus how long the picture has been on air. TS
 * Director's `ProgrammeHeldPictureWall`.
 *
 * A frame's wall clock comes from the camera that captured its picture, never from the phone's "now".
 * A repeat used to carry none and borrow the lag the recording's part had last measured, but a part
 * that has just opened has measured none. A part that opens on a picture held since before the last
 * part finished, or held through a camera loss longer than the recording believes a capture time,
 * was anchored as of now, a whole picture delay late.
 *
 * Kept by the programme tick, which sees every picture come on air whether or not the recording is
 * running, so a repeat is placed from its picture however long ago that was.
 */
class ProgrammeHeldPictureWall {
    /** The picture on air, and the wall second of the tick that first showed it. */
    private var sequence: Long? = null
    private var onAirSince = 0.0

    /** The capture time to send with picture [sequence], captured at [capture], on the tick at wall second [wallNow]. */
    fun capture(sequence: Long, capture: Double, wallNow: Double): Double {
        if (sequence != this.sequence) {
            this.sequence = sequence
            onAirSince = wallNow
        }
        return capture + (wallNow - onAirSince)
    }

    fun reset() {
        sequence = null
    }
}
