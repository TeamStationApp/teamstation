package app.teamstation.streamcore.phonestream

/**
 * Chooses the programme's picture on each tick by when it was captured: TS Director's
 * `ProgrammePictureQueue`, for the camera pictures a phone's renderer holds on the GPU.
 *
 * A picture captured at W belongs on the programme at W + D. On each tick the newest picture whose
 * moment has come (within [toleranceSeconds]) is taken; when none has, the last one is shown again.
 * So the camera's frame rate only changes how often a picture repeats, and never where a picture
 * sits against the sound, which is laid by capture time. A picture that arrives more than a whole
 * tick after its moment is dropped rather than shown late, unless nothing has been shown yet.
 *
 * Pictures are named by their sensor timestamp ([Entry.captureNanos]), which is how the renderer
 * finds the texture holding one; [Entry.captureWall] is the same instant on the steady wall clock.
 */
class ProgrammePictureQueue(delaySeconds: Double) {
    data class Entry(val captureNanos: Long, val captureWall: Double, val sequence: Long) {
        fun moment(delay: Double): Double = captureWall + delay
    }

    var delaySeconds: Double = maxOf(0.0, delaySeconds)
        private set

    private val queued = ArrayDeque<Entry>()
    private var lastTick: Double? = null
    private var nextSequence = 0L

    /** The picture on air, repeated until a newer one is due. */
    var current: Entry? = null
        private set

    /** Pictures dropped because they arrived after their moment, or after a newer one was shown. */
    var latePictures = 0L
        private set

    /** Pictures never shown because a newer one was due on the same tick. */
    var skippedPictures = 0L
        private set

    val count: Int get() = queued.size

    /** The pictures the renderer still has to keep: the one on air and those queued, by sensor timestamp. */
    val wanted: Set<Long> get() = buildSet {
        current?.let { add(it.captureNanos) }
        queued.forEach { add(it.captureNanos) }
    }

    /** A picture from the camera, as it arrives, captured at [captureWall]. */
    fun add(captureNanos: Long, captureWall: Double) {
        val shown = current
        if (shown != null && captureWall < shown.captureWall) {
            latePictures += 1
            return
        }
        if (queued.any { it.captureNanos == captureNanos } || shown?.captureNanos == captureNanos) return
        nextSequence += 1
        val entry = Entry(captureNanos, captureWall, nextSequence)
        val index = queued.indexOfLast { it.captureWall <= captureWall }
        queued.add(index + 1, entry)
        // Bounded by time: the newest capture less the delay and the spare.
        val floor = queued.last().captureWall - delaySeconds - spareSeconds
        queued.removeAll { it.captureWall < floor }
        while (queued.size > maximumQueued) queued.removeFirst()
    }

    /** The picture for the tick at steady wall [now], ticks being [period] apart: the newest due, or the last again. */
    fun pick(now: Double, period: Double): Entry? {
        val due = now + toleranceSeconds
        var chosen = -1
        for ((index, entry) in queued.withIndex()) {
            if (entry.moment(delaySeconds) <= due) chosen = index else break
        }
        if (chosen >= 0) {
            var candidate = queued[chosen]
            val shown = current
            val previous = lastTick
            if (previous != null && shown != null &&
                candidate.moment(delaySeconds) <= previous - period - toleranceSeconds
            ) {
                // Its moment passed a whole tick ago and it was not here then.
                latePictures += 1
                candidate = shown
            } else {
                skippedPictures += chosen
            }
            current = candidate
            repeat(chosen + 1) { queued.removeFirst() }
        }
        lastTick = now
        return current
    }

    /** Forgets every picture and the one on air: a new run of the programme. */
    fun reset() {
        queued.clear()
        current = null
        lastTick = null
    }

    companion object {
        const val toleranceSeconds = 0.002
        const val spareSeconds = 0.25
        const val maximumQueued = 64
    }
}
