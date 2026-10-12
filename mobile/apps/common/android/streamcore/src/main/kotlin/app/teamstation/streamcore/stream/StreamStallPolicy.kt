package app.teamstation.streamcore.stream

/** What the stream's GOP watchdog should do on this tick. */
enum class StreamStallAction { NONE, ENCODE_IDLE_IDR, RESET_SESSION }

/**
 * The stall policy for [ProgramStreamer]: pure, no codec and no timers. A port of TS Director's
 * `StreamStallPolicy`.
 *
 * The watchdog either asks for an IDR of the last picture, or, if the encoder's callbacks have gone
 * silent (or carry no pictures), rebuilds the session, at most once per [resetCooldown].
 */
class StreamStallPolicy(gopSeconds: Double = 2.0, resetCooldown: Double = 10.0) {
    val gopSeconds: Double = maxOf(gopSeconds, 0.1)
    val resetCooldown: Double = maxOf(resetCooldown, 0.0)

    fun action(
        now: Double,
        lastKeyframeWall: Double,
        lastCallbackWall: Double,
        pendingEncodes: Int,
        hasLastFrame: Boolean,
        lastResetWall: Double,
        startedWall: Double = 0.0,
        lastOutputWall: Double = 0.0
    ): StreamStallAction {
        val cooledDown = lastResetWall == 0.0 || now - lastResetWall >= resetCooldown

        // Callbacks still arriving, but carrying errors and no picture: only a rebuilt session
        // recovers an encoder doing that. Measured from the last good output, or from the start.
        if ((startedWall > 0 || lastOutputWall > 0) && lastCallbackWall > 0 && now - lastCallbackWall < gopSeconds) {
            val outputSilent = if (lastOutputWall > 0) {
                now - lastOutputWall >= 2 * gopSeconds
            } else {
                now - startedWall >= 3 * gopSeconds
            }
            if (outputSilent && cooledDown) return StreamStallAction.RESET_SESSION
        }
        val resetDue = pendingEncodes > 0 && lastCallbackWall > 0 &&
            now - lastCallbackWall >= 2 * gopSeconds && cooledDown
        if (resetDue) return StreamStallAction.RESET_SESSION

        // A stream that has never had a callback since it started. A first encode can be slow, so
        // this waits three GOPs rather than two.
        val firstCallbackOverdue = pendingEncodes > 0 && lastCallbackWall == 0.0 && startedWall > 0 &&
            now - startedWall >= 3 * gopSeconds && cooledDown
        if (firstCallbackOverdue) return StreamStallAction.RESET_SESSION

        // Overdue is half a GOP past when the encoder's own keyframe was due, so the watchdog does
        // not race a regular keyframe that came a moment late.
        val overdueAfter = gopSeconds * 1.5
        val keyframeOverdue = if (lastKeyframeWall > 0) {
            now - lastKeyframeWall >= overdueAfter
        } else {
            startedWall > 0 && now - startedWall >= overdueAfter
        }
        if (hasLastFrame && keyframeOverdue) return StreamStallAction.ENCODE_IDLE_IDR
        return StreamStallAction.NONE
    }
}
