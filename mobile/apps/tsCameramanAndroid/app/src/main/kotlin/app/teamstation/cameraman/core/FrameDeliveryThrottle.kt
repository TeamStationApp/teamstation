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
data class FrameDelivery(
    /** Frames per second, 0 for off. */
    val frameRate: Double = 0.0,
    val swing: FrameRateSwing? = null
) {
    val isOff: Boolean get() = swing == null && frameRate <= 0

    /** The rate to deliver [elapsed] seconds after the throttle was configured. Null when off. */
    fun targetRate(elapsed: Double): Double? {
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

    val delivery: FrameDelivery get() = synchronized(lock) { configured }

    /** Starts a new delivery pattern from the next frame. A swing starts at its `low`. */
    fun configure(delivery: FrameDelivery) = synchronized(lock) {
        configured = delivery
        anchor = null
        due = null
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
        val rate = configured.targetRate(time - start) ?: return true
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
