package app.teamstation.streamcore.record

/**
 * Where a programme part's timeline begins on the wall clock, settled once and never revised. A port
 * of TS Director's `ProgrammeSoundOrigin`.
 *
 * Sound captured at `wall` goes at `wall - partStartWall`: one subtraction, fixed for the part. The
 * origin is the median of the pictures' implied part starts (content wall less where the picture was
 * placed) over the part's first 1.5 s, so one frame's jitter does not become a fixed error. It is not
 * followed afterwards: an MP4 sound track is a contiguous run of durations and cannot express a
 * correction without losing time.
 */
class ProgrammeSoundOrigin {
    private val samples = mutableListOf<Double>()
    private var openedAt: Double? = null

    /** The origin, once fixed. */
    var partStartWall: Double? = null
        private set

    val isSettled: Boolean get() = partStartWall != null

    /** Offers one picture's implied origin. Ignored once settled. */
    fun offer(impliedPartStart: Double, atProgramme: Double) {
        if (partStartWall != null || !impliedPartStart.isFinite() || !atProgramme.isFinite()) return
        val opened = openedAt ?: atProgramme.also { openedAt = it }
        samples += impliedPartStart
        if (atProgramme - opened < seedSeconds && samples.size < maximumSamples) return
        partStartWall = median(samples)
        samples.clear()
    }

    /** Where sound captured at [wall] belongs on the part's timeline; null before it is settled or before the part. */
    fun timeline(captureWall: Double): Double? {
        val settled = partStartWall ?: return null
        if (!captureWall.isFinite()) return null
        val seconds = captureWall - settled
        return if (seconds >= 0) seconds else null
    }

    fun reset() {
        samples.clear()
        openedAt = null
        partStartWall = null
    }

    companion object {
        /** How long the opening is sampled before the origin is fixed. */
        const val seedSeconds = 1.5

        /** A ceiling on the samples held while seeding. */
        const val maximumSamples = 240

        fun median(values: List<Double>): Double? {
            if (values.isEmpty()) return null
            val sorted = values.sorted()
            val middle = sorted.size / 2
            return if (sorted.size % 2 == 1) sorted[middle] else (sorted[middle - 1] + sorted[middle]) / 2
        }
    }
}
