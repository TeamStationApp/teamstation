package app.teamstation.speedy.core

/** Something the announcer can cancel: its waiting pitch's timer. */
fun interface Cancellable {
    fun cancel()
}

/** Runs [work] on the main thread after [delayMs]. The app's is a Handler; tests step a clock. */
fun interface Scheduler {
    fun after(delayMs: Long, work: () -> Unit): Cancellable
}

/**
 * Decides what to say for each reading.
 *
 * A pitch waits [HOLD_MS] for an exit to follow it. An exit inside that window joins it ("56 and
 * 52 exit"); otherwise the pitch is said alone when the window closes ("56"), and a later exit is
 * said on its own ("52 exit"). A reading that carries both says them together at once: in Pitch &
 * Hit the hit's frame repeats the pitch it follows, so a pitch still waiting is the same pitch and
 * is not said twice. Nor is a pitch already said alone: a hit frame that comes after the hold,
 * while that pitch is still on the board, says only its exit. With audio off, readings are ignored.
 */
class Announcer(
    audioOn: Boolean,
    private val scheduler: Scheduler,
    private val now: () -> Long = System::currentTimeMillis,
    private val speak: (List<String>) -> Unit
) {
    var audioOn: Boolean = audioOn
        set(value) {
            field = value
            if (!value) dropPending()
        }

    private var pendingPitch: Int? = null
    private var timer: Cancellable? = null
    /** The pitch last said, and when, so a hit frame repeating it does not say it again. */
    private var saidPitch: Pair<Int, Long>? = null

    fun receive(pitch: Int, exit: Int) {
        if (!audioOn) return
        when {
            pitch > 0 && exit > 0 -> {
                // A waiting pitch is this frame's pitch, new and unsaid; with none waiting, the
                // frame may repeat a pitch already said.
                val repeat = pendingPitch == null && alreadySaid(pitch)
                dropPending()
                say(if (repeat) null else pitch, exit)
            }
            pitch > 0 -> {
                flushPending()
                pendingPitch = pitch
                timer = scheduler.after(HOLD_MS) { flushPending() }
            }
            exit > 0 -> {
                val pending = pendingPitch
                dropPending()
                say(pending, exit)
            }
        }
    }

    /** Forgets a pitch that has not been said. */
    fun reset() = dropPending()

    private fun flushPending() {
        val pending = pendingPitch ?: return
        dropPending()
        say(pending, null)
    }

    private fun dropPending() {
        timer?.cancel()
        timer = null
        pendingPitch = null
    }

    /** Whether [pitch] was said on its own within the time the board still shows it. */
    private fun alreadySaid(pitch: Int): Boolean {
        val (mph, at) = saidPitch ?: return false
        return mph == pitch && now() - at < SpeedBoard.HOLD_MS
    }

    private fun say(pitch: Int?, exit: Int?) {
        if (pitch != null) saidPitch = pitch to now()
        val clips = Phrase.clips(pitch, exit)
        if (clips.isNotEmpty()) speak(clips)
    }

    companion object {
        const val HOLD_MS = 250L
    }
}
