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
 * is not said twice. With audio off, readings are ignored.
 */
class Announcer(
    audioOn: Boolean,
    private val scheduler: Scheduler,
    private val speak: (List<String>) -> Unit
) {
    var audioOn: Boolean = audioOn
        set(value) {
            field = value
            if (!value) dropPending()
        }

    private var pendingPitch: Int? = null
    private var timer: Cancellable? = null

    fun receive(pitch: Int, exit: Int) {
        if (!audioOn) return
        when {
            pitch > 0 && exit > 0 -> {
                dropPending()
                say(pitch, exit)
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

    private fun say(pitch: Int?, exit: Int?) {
        val clips = Phrase.clips(pitch, exit)
        if (clips.isNotEmpty()) speak(clips)
    }

    companion object {
        const val HOLD_MS = 250L
    }
}
