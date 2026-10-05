package app.teamstation.cameraman.core

import java.util.ArrayDeque
import kotlin.math.max

// A test tool: makes a camera deliver fewer frames than it captures, the way a phone throttling from
// heat does, while everything else about the stream stays as it is.
//
// A port of the iOS build's `FrameDeliveryThrottle.swift`, rule for rule. Changing
// `videoEncoder.rateControl.frameRateLimit` switches the capture format and restarts the session,
// which a receiver sees as a reconnect. This instead drops captured frames before they reach the
// encoder. The capture format, the declared rate, the SDP, the session and the sound are untouched,
// and every kept frame keeps its own capture time, so the receiver sees a connected camera sending
// fewer, unevenly spaced frames. It is off at every launch and is never saved.

/**
 * A delivered rate that moves from [low] up to [high] and back down to [low] over each
 * [periodSeconds], linearly, starting at [low]. On the wire it is `low:high:period`.
 */
data class FrameRateSwing(val low: Double, val high: Double, val periodSeconds: Double) {
    val text: String
        get() = listOf(low, high, periodSeconds).joinToString(":") { CameraParameters.number(it) }

    /** The rate [elapsed] seconds into the swing: a triangle from [low] to [high] and back. */
    fun rate(elapsed: Double): Double {
        val phase = (elapsed / periodSeconds) % 1.0
        val rising = if (phase < 0) phase + 1 else phase
        val fraction = if (rising < 0.5) rising * 2 else (1 - rising) * 2
        return low + (high - low) * fraction
    }

    companion object {
        /**
         * Parses `low:high:period`. Null for anything else, including a `low` above `high` or a
         * rate outside what [FrameDelivery] accepts.
         */
        fun parse(text: String): FrameRateSwing? {
            val parts = text.split(":").map { it.trim().toDoubleOrNull() }
            if (parts.size != 3) return null
            val low = parts[0] ?: return null
            val high = parts[1] ?: return null
            val period = parts[2] ?: return null
            if (!FrameDelivery.accepts(low) || !FrameDelivery.accepts(high) || low > high) return null
            if (!period.isFinite() || period <= 0) return null
            return FrameRateSwing(low, high, period)
        }
    }
}

/**
 * What the throttle is told to do: a steady rate, a swing, or nothing. A swing wins over a steady
 * rate when both are set.
 */
/**
 * SplitMix64: the same sequence on every platform, so a wander's seed replays the same schedule on
 * the Pixel and the iPhone.
 */
class SeededRandom(seed: Long) {
    private var state = seed

    fun next(): Long {
        state += -0x61c8864680b583ebL
        var z = state
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        return z xor (z ushr 31)
    }

    /** Uniform in `0 until 1`. */
    fun unit(): Double = (next() ushr 11).toDouble() / (1L shl 53).toDouble()
}

/**
 * A delivered rate that wanders at random, the way a phone's does as it heats on a solid network:
 * hold a rate for `minHold`–`maxHold` s, then move to a target uniform in `low`–`high` as a step or
 * a 1–5 s ramp (even odds); about one move in eight is a deep dip to 8–15 fps for 1–4 s, recovering
 * by a 1–5 s ramp. It starts at `high`. A port of the iOS `FrameRateWander`, draw for draw, so a
 * seed gives the same schedule on both. On the wire `low:high:minHold:maxHold:seed`, the seed as an
 * unsigned 64-bit decimal.
 */
data class FrameRateWander(
    val low: Double,
    val high: Double,
    val minHoldSeconds: Double,
    val maxHoldSeconds: Double,
    val seed: Long
) {
    val text: String
        get() = (listOf(low, high, minHoldSeconds, maxHoldSeconds).map { CameraParameters.number(it) } +
            java.lang.Long.toUnsignedString(seed)).joinToString(":")

    companion object {
        const val dipProbability = 1.0 / 8
        val dipRates = 8.0..15.0
        val dipSeconds = 1.0..4.0
        val rampSeconds = 1.0..5.0

        fun parse(text: String, randomSeed: () -> Long = { kotlin.random.Random.nextLong() }): FrameRateWander? {
            val parts = text.split(":").map { it.trim() }
            if (parts.size != 4 && parts.size != 5) return null
            val numbers = parts.take(4).map { it.toDoubleOrNull() }
            val low = numbers[0] ?: return null
            val high = numbers[1] ?: return null
            val minHold = numbers[2] ?: return null
            val maxHold = numbers[3] ?: return null
            if (!FrameDelivery.accepts(low) || !FrameDelivery.accepts(high) || low > high) return null
            if (!minHold.isFinite() || !maxHold.isFinite() || minHold <= 0 || minHold > maxHold) return null
            val seed = if (parts.size == 5) parts[4].toULongOrNull()?.toLong() ?: return null else randomSeed()
            return FrameRateWander(low, high, minHold, maxHold, seed)
        }
    }
}

/** A wander's schedule, generated from its seed as far as it has been asked about. */
class WanderSchedule(val wander: FrameRateWander) {
    data class Segment(val start: Double, val end: Double, val from: Double, val to: Double, val isDip: Boolean)

    val segments = ArrayList<Segment>()
    private val random = SeededRandom(wander.seed)
    private var time = 0.0
    private var rate = wander.high
    var moves = 0
        private set
    var dips = 0
        private set

    fun rate(elapsed: Double): Double {
        extend(elapsed)
        val segment = segments.lastOrNull { it.start <= elapsed } ?: return wander.high
        if (segment.end <= segment.start || segment.from == segment.to) return segment.from
        val fraction = ((elapsed - segment.start) / (segment.end - segment.start)).coerceIn(0.0, 1.0)
        return segment.from + (segment.to - segment.from) * fraction
    }

    fun extend(elapsed: Double) {
        while (time <= elapsed) {
            val w = wander
            val hold = w.minHoldSeconds + (w.maxHoldSeconds - w.minHoldSeconds) * random.unit()
            append(hold, rate, rate, false)
            moves += 1
            if (random.unit() < FrameRateWander.dipProbability) {
                dips += 1
                val dip = draw(FrameRateWander.dipRates)
                append(draw(FrameRateWander.dipSeconds), dip, dip, true)
                val target = w.low + (w.high - w.low) * random.unit()
                append(draw(FrameRateWander.rampSeconds), dip, target, false)
                rate = target
            } else {
                val target = w.low + (w.high - w.low) * random.unit()
                if (random.unit() >= 0.5) append(draw(FrameRateWander.rampSeconds), rate, target, false)
                rate = target
            }
        }
    }

    private fun draw(range: ClosedFloatingPointRange<Double>): Double =
        range.start + (range.endInclusive - range.start) * random.unit()

    private fun append(duration: Double, from: Double, to: Double, isDip: Boolean) {
        segments.add(Segment(time, time + duration, from, to, isDip))
        time += duration
    }
}

data class FrameDelivery(
    /** Frames per second, 0 for off. */
    val frameRate: Double = 0.0,
    val swing: FrameRateSwing? = null,
    /** Wins over the swing and the steady rate while set. */
    val wander: FrameRateWander? = null
) {
    val isOff: Boolean get() = wander == null && swing == null && frameRate <= 0

    /** The rate to deliver [elapsed] seconds after the throttle was configured. Null when off. */
    fun targetRate(elapsed: Double): Double? {
        wander?.let { return WanderSchedule(it).rate(elapsed) }
        swing?.let { return it.rate(elapsed) }
        return if (frameRate > 0) frameRate else null
    }

    companion object {
        val off = FrameDelivery()

        /**
         * The slowest and fastest rates accepted. One frame a second is already a camera in
         * trouble; above 240 nothing a phone captures is throttled.
         */
        const val minimumRate = 1.0
        const val maximumRate = 240.0

        /** Whether [rate] is a rate a throttle can be told to deliver. 0, for off, is checked separately. */
        fun accepts(rate: Double): Boolean = rate.isFinite() && rate >= minimumRate && rate <= maximumRate
    }
}

/**
 * Decides, frame by frame, which captured frames reach the encoder, and measures how many did.
 *
 * Called from the render thread for every captured frame, with that frame's capture time; read from
 * anywhere for the rate it is delivering. Kept frames are due at intervals of `1 / rate`, each
 * varied by up to ±30%, counted from the previous due time rather than the previous kept frame, so
 * the long-run rate is the one asked for even though only whole captured frames can be kept.
 *
 * [random] returns values in `0 until 1`; tests pass a seeded generator.
 */
class FrameDeliveryThrottle(private val random: () -> Double = { Math.random() }) {
    private val lock = Any()
    private var configured = FrameDelivery.off
    private var anchor: Double? = null
    private var due: Double? = null
    private var lastSeen: Double? = null
    private val delivered = ArrayDeque<Double>()
    private var schedule: WanderSchedule? = null

    val delivery: FrameDelivery get() = synchronized(lock) { configured }

    /** Starts a new delivery pattern from the next frame. A swing starts at its `low`. */
    fun configure(delivery: FrameDelivery) = synchronized(lock) {
        configured = delivery
        anchor = null
        due = null
        schedule = delivery.wander?.let { WanderSchedule(it) }
    }

    /** The rate a wander is asking for now, null without one. */
    val wanderTarget: Double?
        get() = synchronized(lock) {
            val current = schedule ?: return@synchronized null
            val start = anchor ?: return@synchronized null
            val seen = lastSeen ?: return@synchronized null
            current.rate(seen - start)
        }

    /** Whether the frame captured at [captureTime] seconds should be encoded. */
    fun shouldDeliver(captureTime: Double): Boolean = synchronized(lock) {
        val previous = lastSeen
        if (previous != null && captureTime < previous - clockStepBack) {
            anchor = null
            due = null
            delivered.clear()
        }
        lastSeen = captureTime
        if (!keep(captureTime)) return@synchronized false
        delivered.addLast(captureTime)
        while (captureTime - delivered.first() > measurementWindow) delivered.removeFirst()
        true
    }

    /**
     * Frames per second reaching the encoder over the last two seconds of capture time, whether or
     * not a throttle is set. Null until two frames have been delivered.
     */
    val deliveredFrameRate: Double?
        get() = synchronized(lock) {
            if (delivered.size < 2) return@synchronized null
            val span = delivered.last() - delivered.first()
            if (span <= 0) null else (delivered.size - 1) / span
        }

    private fun keep(time: Double): Boolean {
        val start = anchor ?: time
        anchor = start
        val rate = schedule?.rate(time - start) ?: configured.targetRate(time - start) ?: return true
        val next = due ?: time
        if (time + earlyTolerance < next) return false
        val mean = 1 / rate
        val interval = mean * (1 + jitter * (2 * random() - 1))
        // From the due time, so the rate is exact on average; but never from further back than one
        // mean interval, or a rate the camera cannot reach would build a backlog and then a burst.
        due = max(next, time - mean) + interval
        return true
    }

    companion object {
        /** How far each interval is varied either way, as a fraction of `1 / rate`. */
        const val jitter = 0.3

        /** The window the delivered rate is measured over. */
        const val measurementWindow = 2.0

        /** A frame this close before its due time is kept: capture times wobble by a millisecond or so. */
        internal const val earlyTolerance = 0.001

        /** A capture time this far behind the last one is a new clock (a session restart), not a frame. */
        internal const val clockStepBack = 0.5
    }
}
