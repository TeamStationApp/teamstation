package app.teamstation.cameraman.core

/*
 * A test tool: makes a healthy phone behave like a hot one. A phone that has throttled itself starves
 * its whole pipeline, not only its picture: in one game a hot camera delivered about
 * 25 fps all game, its GOPs spread over 3.1-6.7 s, and its sound reached the iPad at 53% of real
 * time. The wander drops pictures from an otherwise healthy phone; this starves the rest. Three
 * parts, each with its own level, all from one seed so a run can be replayed. A port of the iOS
 * `StruggleInjector`, draw for draw, so a seed does the same on both:
 *
 * - `mic`: microphone sound lost before it is encoded, in irregular bursts, about this fraction of
 *   the time (at most 0.5). Never counted, never sent, as an overrun loses it.
 * - `hold`: the outgoing packets of both streams held for 0.3-2 s at a time, then released in one
 *   burst, about this fraction of the time. Capture times stay true.
 * - `slow`: windows of 1-5 s, about this fraction of the time, in which only one picture in every
 *   50-250 ms reaches the encoder: the picture rate out falls irregularly, as a starved encoder's.
 *
 * Off at every launch and never saved. It combines with the frame-rate throttle.
 */

/** What the injector is told to do. On the wire `mic:hold:slow:seed`, the seed unsigned decimal. */
data class Struggle(val mic: Double, val hold: Double, val slow: Double, val seed: Long) {
    val text: String
        get() = (listOf(mic, hold, slow).map { CameraParameters.number(it) } +
            java.lang.Long.toUnsignedString(seed)).joinToString(":")

    val isOff: Boolean get() = mic <= 0 && hold <= 0 && slow <= 0

    companion object {
        const val maximumMic = 0.5
        const val maximumHold = 0.9
        const val maximumSlow = 0.95

        /** Parses `mic:hold:slow[:seed]`, each level within its maximum. Without a seed one is picked. */
        fun parse(text: String, randomSeed: () -> Long = { kotlin.random.Random.nextLong() }): Struggle? {
            val parts = text.split(":").map { it.trim() }
            if (parts.size != 3 && parts.size != 4) return null
            val levels = parts.take(3).map { it.toDoubleOrNull() }
            val mic = levels[0] ?: return null
            val hold = levels[1] ?: return null
            val slow = levels[2] ?: return null
            if (mic !in 0.0..maximumMic || hold !in 0.0..maximumHold || slow !in 0.0..maximumSlow) return null
            val seed = if (parts.size == 4) parts[3].toULongOrNull()?.toLong() ?: return null else randomSeed()
            return Struggle(mic, hold, slow, seed)
        }
    }
}

/**
 * Alternating quiet gaps and windows on one seeded stream: each window lasts uniformly within
 * [window], each gap is uniform in `0..2 x mean gap`, the mean gap set so windows take about [level]
 * of the time. It starts with a gap.
 */
class WindowSchedule(seed: Long, val level: Double, val window: ClosedFloatingPointRange<Double>) {
    private val random = SeededRandom(seed)
    private var time = 0.0
    val windows = ArrayList<ClosedFloatingPointRange<Double>>()

    /** The window [elapsed] falls in, if any. */
    fun windowAt(elapsed: Double): ClosedFloatingPointRange<Double>? {
        if (level <= 0) return null
        extend(elapsed)
        return windows.lastOrNull { it.start <= elapsed && elapsed < it.endInclusive }
    }

    fun extend(elapsed: Double) {
        if (level <= 0) return
        val meanWindow = (window.start + window.endInclusive) / 2
        val meanGap = meanWindow * (1 - level) / level
        while (time <= elapsed) {
            time += 2 * meanGap * random.unit()
            val length = window.start + (window.endInclusive - window.start) * random.unit()
            windows.add(time..time + length)
            time += length
        }
    }
}

/**
 * Applies a [Struggle] to one camera. Each part keeps its own clock, anchored at the first time it
 * is asked: capture time for sound and pictures, the monotonic clock for the send hold.
 */
class StruggleInjector {
    data class Summary(val droppedSoundSeconds: Double, val holds: Int, val droppedFrames: Long)

    private val lock = Any()
    private var configured: Struggle? = null
    private var mic: WindowSchedule? = null
    private var hold: WindowSchedule? = null
    private var slow: WindowSchedule? = null
    private var spacing: SeededRandom? = null
    private var micAnchor: Double? = null
    private var holdAnchor: Double? = null
    private var slowAnchor: Double? = null
    private var nextSlowFrame: Double? = null
    private var droppedSoundSeconds = 0.0
    private var holds = 0
    private var droppedFrames = 0L
    private var lastHold: ClosedFloatingPointRange<Double>? = null

    val struggle: Struggle? get() = synchronized(lock) { configured }

    /** What it has done since configured. */
    fun summary(): Summary = synchronized(lock) { Summary(droppedSoundSeconds, holds, droppedFrames) }

    fun configure(struggle: Struggle?) = synchronized(lock) {
        val active = struggle?.takeUnless { it.isOff }
        configured = active
        mic = active?.let { WindowSchedule(it.seed xor 0x6D69_6300L, it.mic, micBurst) }
        hold = active?.let { WindowSchedule(it.seed xor 0x686F_6C64L, it.hold, holdLength) }
        slow = active?.let { WindowSchedule(it.seed xor 0x736C_6F77L, it.slow, slowWindow) }
        spacing = active?.let { SeededRandom(it.seed xor 0x7370_6163L) }
        micAnchor = null
        holdAnchor = null
        slowAnchor = null
        nextSlowFrame = null
        lastHold = null
        droppedSoundSeconds = 0.0
        holds = 0
        droppedFrames = 0
    }

    /** Whether sound captured at [captureTime] for [duration] seconds reaches the encoder. */
    fun keepsSound(captureTime: Double, duration: Double): Boolean = synchronized(lock) {
        val schedule = mic ?: return@synchronized true
        val anchor = micAnchor ?: captureTime
        micAnchor = anchor
        if (schedule.windowAt(captureTime - anchor) == null) return@synchronized true
        droppedSoundSeconds += maxOf(0.0, duration)
        false
    }

    /** Whether the picture captured at [captureTime] reaches the encoder. */
    fun keepsFrame(captureTime: Double): Boolean = synchronized(lock) {
        val schedule = slow ?: return@synchronized true
        val anchor = slowAnchor ?: captureTime
        slowAnchor = anchor
        if (schedule.windowAt(captureTime - anchor) == null) {
            nextSlowFrame = null
            return@synchronized true
        }
        val next = nextSlowFrame
        if (next != null && captureTime < next) {
            droppedFrames += 1
            return@synchronized false
        }
        val range = slowSpacing
        nextSlowFrame = captureTime + range.start + (range.endInclusive - range.start) * spacing!!.unit()
        true
    }

    /** When a packet handed over at [now] seconds may leave: the end of its hold, or null for at once. */
    fun holdRelease(now: Double): Double? = synchronized(lock) {
        val schedule = hold ?: return@synchronized null
        val anchor = holdAnchor ?: now
        holdAnchor = anchor
        val window = schedule.windowAt(now - anchor) ?: return@synchronized null
        if (lastHold != window) {
            lastHold = window
            holds += 1
        }
        anchor + window.endInclusive
    }

    companion object {
        val micBurst = 0.02..0.4
        val holdLength = 0.3..2.0
        val slowWindow = 1.0..5.0
        val slowSpacing = 0.05..0.25
    }
}
