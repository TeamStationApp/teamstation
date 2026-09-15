package co.gamestation.cameraman.rtsp

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Chooses the encoder's bitrate from what the link to the weakest client is doing.
 *
 * The operator's bitrate is the ceiling. When the link backs up the rate comes down, never below
 * the floor, and it climbs back once the link has been clean for a while. Below the floor, a softer
 * picture stops being a better trade than the dropped frames it is there to prevent.
 *
 * The iOS build's `AdaptiveBitrateController` is the same algorithm with the same constants; the
 * two are tested against the same scenarios. Every signal is measured on the sender, because nothing
 * comes back from Director: no receiver reports, and on TCP no loss. The rules and constants are
 * taken from controllers built on the same kind of signal:
 *
 * - OBS's dynamic bitrate (`plugins/obs-outputs/rtmp-stream.c`) is the closest relative: RTMP over
 *   TCP, sender-side only. It measures the queue as the age of what is waiting, cuts when that
 *   passes 200 ms, cuts straight to the measured delivery rate, and adds a tenth of the ceiling
 *   every 4 s.
 * - GCC (draft-ietf-rmcat-gcc-02) decreases to 0.85 of the measured rate and increases by 8% a
 *   second, capped at 1.5 times what the link is delivering.
 * - SCReAM (RFC 8298) trims by 5% when its own sender queue delays, and slows its ramp near the rate
 *   where congestion last happened. Its delay targets, like OBS's, assume a receiver with a deeper
 *   buffer than Director's; the iOS build's `Tuning` says what they are here and why.
 * - BBR's point that a delivery rate measured while the sender had nothing waiting says what the
 *   encoder produced, not what the link can carry. So the measured rate only sets a cut, which
 *   happens with the queue long, and otherwise only caps a climb.
 * - Hoßfeld et al. (QoMEX 2014) found that viewers mind large quality swings, and time spent below
 *   the best quality, far more than how often the quality moves. So changes are small and spaced,
 *   and recovery is not slow for its own sake.
 */
class AdaptiveBitrateController(
    ceiling: Int,
    /** Half the ceiling when null, and kept between zero and the ceiling either way. */
    floor: Int? = null,
    val tuning: Tuning = Tuning()
) {
    enum class Decision(val rawValue: String) {
        HOLD("hold"),

        /** Frames were dropped, or the queue passed the point where they are about to be. */
        EMERGENCY("emergency"),

        /** The queue has stayed long for two ticks in a row. */
        CONGESTED("congested"),

        /** The queue has grown for three ticks, still short. */
        GROWING("growing"),
        INCREASE("increase")
    }

    /** Each constant's source is given in the iOS build's `Tuning`, which this mirrors. */
    data class Tuning(
        val clearDelay: Double = 0.05,
        val growingDelay: Double = 0.08,
        val congestedDelay: Double = 0.15,
        val emergencyDelay: Double = 0.3,
        val deliveryFactor: Double = 0.85,
        val emergencyFactor: Double = 0.7,
        val congestedFactor: Double = 0.9,
        val growingFactor: Double = 0.95,
        val decreaseHold: Double = 1.0,
        val emergencyHold: Double = 0.5,
        val increaseHold: Double = 4.0,
        val increasePerSecond: Double = 1.08,
        val probeCeilingFactor: Double = 1.5,
        val deliveryWindow: Double = 1.0,
        val minimumChange: Double = 0.05,
        val increasePushInterval: Double = 1.0,
        val quantum: Int = 100_000,
        val shortfall: Double = 0.9,
        val idleReset: Double = 10.0,
        val baseDelayWindow: Double = 10.0
    )

    /** What the controller last did and why, for the state dump. */
    data class Status(
        val ceiling: Int,
        val floor: Int,
        /** What the encoder has been told. */
        val bitrate: Int,
        val lastDecision: Decision = Decision.HOLD,
        val decreases: Int = 0,
        val increases: Int = 0,
        /** The queue delay the last decision was made on, in milliseconds. */
        val queueDelayMilliseconds: Int = 0,
        /** Delivery rate over the last second, or null until a second has been measured. */
        val deliveryBitsPerSecond: Int? = null,
        /**
         * What the transport holds on a clean link, in milliseconds, which is subtracted before its
         * backlog counts as queue.
         */
        val transportBaseMilliseconds: Int = 0
    )

    private class Delivery(val time: Double, val interval: Double, val bytes: Int, val offered: Int)

    private class TransportDelay(val time: Double, val delay: Double)

    var ceiling: Int = ceiling
        private set

    /**
     * The lowest rate a cut may reach: the operator's own low bitrate where there is one, and half
     * the ceiling otherwise. Below the floor a softer picture stops being worth the dropped frames it
     * would save.
     */
    var floor: Int = floorWithin(ceiling, floor)
        private set

    /** Unrounded, so a slow climb is not lost to the quantum. */
    private var target = ceiling.toDouble()

    /** What the encoder was last told. */
    var bitrate: Int = ceiling
        private set

    private val deliveries = ArrayDeque<Delivery>()

    /** The transport's delay, tick by tick, over the base-delay window. */
    private val transportDelays = ArrayDeque<TransportDelay>()
    private var congestedTicks = 0
    private val recentDelays = ArrayDeque<Double>()
    private var lastDecreaseAt = Double.NEGATIVE_INFINITY
    private var lastEmergencyAt = Double.NEGATIVE_INFINITY
    private var lastLossAt = Double.NEGATIVE_INFINITY
    private var lastPushAt = Double.NEGATIVE_INFINITY
    private var lastSampleAt: Double? = null
    /**
     * The rate the link broke at, which a climb approaches slowly from below as SCReAM does: the
     * rate in force when congestion struck, or what the link was actually delivering if that was
     * less. A cut from 4 Mbps on a link carrying 2.4 must not remember 4, or the climb races past
     * 2.4 and finds the same congestion again.
     */
    private var lastCongestedRate: Double? = null

    var status = Status(ceiling = ceiling, floor = this.floor, bitrate = ceiling)
        private set

    /**
     * Starts again at [ceiling], forgetting everything measured. For a new operator rate or floor,
     * and for an encoder that has been rebuilt at the ceiling. [floor] is half the new ceiling when
     * null. The counts carry over: they describe the session.
     */
    fun reset(ceiling: Int, floor: Int? = null) {
        this.ceiling = ceiling
        this.floor = floorWithin(ceiling, floor)
        target = ceiling.toDouble()
        bitrate = ceiling
        deliveries.clear()
        transportDelays.clear()
        congestedTicks = 0
        recentDelays.clear()
        lastDecreaseAt = Double.NEGATIVE_INFINITY
        lastEmergencyAt = Double.NEGATIVE_INFINITY
        lastLossAt = Double.NEGATIVE_INFINITY
        lastPushAt = Double.NEGATIVE_INFINITY
        lastSampleAt = null
        lastCongestedRate = null
        status = Status(
            ceiling = ceiling,
            floor = this.floor,
            bitrate = ceiling,
            decreases = status.decreases,
            increases = status.increases
        )
    }

    /**
     * One tick. Returns the rate to give the encoder, or null when it should keep what it has.
     *
     * [sample] is the worst playing client's link since the previous tick, or null when nobody is
     * playing. [now] is a monotonic clock in seconds.
     */
    fun update(sample: CongestionSample?, now: Double): Int? {
        if (sample == null) {
            // Nobody watching. Held rather than climbed, since there is no link to judge, but not
            // held for ever: a client arriving much later is on a link nothing has been measured
            // about.
            val last = lastSampleAt
            if (last != null && now - last > tuning.idleReset && bitrate != ceiling) {
                reset(ceiling, floor)
                return ceiling
            }
            return null
        }
        lastSampleAt = now

        recordDelivery(sample, now)
        val delivery = deliveryRate()
        val delay = effectiveDelay(sample, delivery, now, isFallingShort(sample))
        recentDelays.addLast(delay)
        while (recentDelays.size > 3) recentDelays.removeFirst()
        congestedTicks = if (delay > tuning.congestedDelay) congestedTicks + 1 else 0

        val lost = sample.droppedFrames + sample.flushes > 0
        if (lost) lastLossAt = now

        val decision = decide(delay, sample.queueDelay, lost, now)
        val measuredCap = delivery?.let { it * tuning.deliveryFactor } ?: Double.POSITIVE_INFINITY
        when (decision) {
            Decision.EMERGENCY -> {
                cut(min(target * tuning.emergencyFactor, measuredCap), now)
                lastEmergencyAt = now
            }
            Decision.CONGESTED -> cut(min(target * tuning.congestedFactor, measuredCap), now)
            Decision.GROWING -> cut(target * tuning.growingFactor, now)
            Decision.INCREASE -> climb(sample.interval, delivery)
            Decision.HOLD -> Unit
        }

        val pushed = push(now)
        status = status.copy(
            bitrate = bitrate,
            lastDecision = decision,
            queueDelayMilliseconds = (delay * 1000).roundToInt(),
            deliveryBitsPerSecond = delivery?.roundToInt()
        )
        return pushed
    }

    // MARK: - Measuring

    private fun recordDelivery(sample: CongestionSample, now: Double) {
        if (sample.interval <= 0) return
        deliveries.addLast(Delivery(now, sample.interval, sample.drainedBytes, sample.offeredBytes))
        // Kept a little past the window, so the window is always fully covered once it can be.
        while (deliveries.isNotEmpty() && now - deliveries.first().time > tuning.deliveryWindow + 0.5) {
            deliveries.removeFirst()
        }
    }

    /**
     * Whether the link carried less than the encoder offered over the last second, or frames are
     * already waiting in this app: the two ways a backlog in the transport can be told apart from
     * bytes that are merely in flight for longer.
     */
    private fun isFallingShort(sample: CongestionSample): Boolean {
        if (sample.queueDelay > 0.02) return true
        var covered = 0.0
        var drained = 0L
        var offered = 0L
        for (entry in deliveries.asReversed()) {
            covered += entry.interval
            drained += entry.bytes
            offered += entry.offered
            if (covered >= tuning.deliveryWindow * 0.95) break
        }
        if (covered < tuning.deliveryWindow * 0.95 || offered <= 0) return false
        return drained < offered * tuning.shortfall
    }

    /** Bits per second the link carried over the last second, or null until a second is measured. */
    private fun deliveryRate(): Double? {
        var covered = 0.0
        var bytes = 0L
        for (entry in deliveries.asReversed()) {
            covered += entry.interval
            bytes += entry.bytes
            if (covered >= tuning.deliveryWindow * 0.95) break
        }
        if (covered < tuning.deliveryWindow * 0.95) return null
        return bytes * 8.0 / covered
    }

    /**
     * How long a frame sent now would wait: its time in this app's queue, plus however much longer
     * than usual the transport's own backlog takes to drain at the rate the link is carrying.
     *
     * The kernel's count includes bytes in flight, so on a clean link it reads about one round
     * trip, and a keyframe lands in it as a burst that is gone a tick later. So only a standing
     * queue counts — the smaller of this tick and the last, CoDel's rule — and only above the
     * smallest delay of the last ten seconds, which is flight time rather than queue. And even a
     * standing backlog is only queue while the link is falling short: a longer round trip puts more
     * bytes in flight while the link still carries everything. The iOS build's comment has the
     * measurements.
     */
    private fun effectiveDelay(
        sample: CongestionSample,
        delivery: Double?,
        now: Double,
        isFallingShort: Boolean
    ): Double {
        val backlog = sample.transportBacklogBytes ?: return sample.queueDelay
        val rate = max(delivery ?: 0.0, floor.toDouble())
        val transport = min(max(0, backlog) * 8.0 / rate, 10.0)
        val standing = min(transport, transportDelays.lastOrNull()?.delay ?: transport)
        transportDelays.addLast(TransportDelay(now, transport))
        while (transportDelays.isNotEmpty() && now - transportDelays.first().time > tuning.baseDelayWindow) {
            transportDelays.removeFirst()
        }
        val base = transportDelays.minOf { it.delay }
        status = status.copy(transportBaseMilliseconds = (base * 1000).roundToInt())
        if (!isFallingShort) return sample.queueDelay
        return sample.queueDelay + max(0.0, standing - base)
    }

    // MARK: - Deciding

    private fun decide(delay: Double, appDelay: Double, lost: Boolean, now: Double): Decision {
        val sinceDecrease = now - lastDecreaseAt
        // Each cut is judged against the rate it would leave; one already at the floor has nowhere
        // to go.
        val canCut = target > floor
        // The large cut is for frames lost or about to be: a queue in this app, which only builds
        // once the transport is full. The transport's own backlog is an estimate, and earns the
        // smaller steps.
        if (canCut && (lost || appDelay > tuning.emergencyDelay) &&
            now - lastEmergencyAt >= tuning.emergencyHold
        ) {
            return Decision.EMERGENCY
        }
        if (canCut && congestedTicks >= 2 && sinceDecrease >= tuning.decreaseHold) {
            return Decision.CONGESTED
        }
        if (canCut && delay > tuning.growingDelay && isGrowing && sinceDecrease >= tuning.decreaseHold) {
            return Decision.GROWING
        }
        if (target < ceiling && delay < tuning.clearDelay &&
            now - lastLossAt >= tuning.increaseHold && sinceDecrease >= tuning.increaseHold
        ) {
            return Decision.INCREASE
        }
        return Decision.HOLD
    }

    /** Three ticks each longer than the one before: a queue building, as opposed to one burst. */
    private val isGrowing: Boolean
        get() = recentDelays.size >= 3 && recentDelays.zipWithNext().all { (a, b) -> a < b }

    private fun cut(rate: Double, now: Double) {
        val next = max(floor.toDouble(), rate)
        if (next >= target) return
        lastCongestedRate = min(target, deliveryRate() ?: target)
        target = next
        lastDecreaseAt = now
        congestedTicks = 0
        status = status.copy(decreases = status.decreases + 1)
    }

    private fun climb(elapsed: Double, delivery: Double?) {
        var factor = tuning.increasePerSecond.pow(max(0.0, elapsed)) - 1
        // SCReAM's approach to the last congested rate: full speed from well below it, a fifth of
        // that within 10% either side, so the climb lingers where it last went wrong instead of
        // overshooting.
        val last = lastCongestedRate
        if (last != null && last > 0) {
            val distance = (target - last) / last
            factor *= max(0.2, min(1.0, (4 * distance).pow(2)))
        }
        var next = target * (1 + factor)
        delivery?.let { next = min(next, it * tuning.probeCeilingFactor) }
        next = min(next, ceiling.toDouble())
        if (next <= target) return
        target = next
        if (target >= ceiling) lastCongestedRate = null
    }

    // MARK: - Pushing

    private fun push(now: Double): Int? {
        val rounded = (target.toInt() / tuning.quantum) * tuning.quantum
        // The floor and ceiling themselves are always reachable, whatever the quantum makes of them.
        val next = if (target >= ceiling) ceiling else max(floor, rounded)
        if (next == bitrate) return null

        val isDecrease = next < bitrate
        val atBound = next == ceiling || next == floor
        val change = abs((next - bitrate).toDouble()) / bitrate
        if (change < tuning.minimumChange && !atBound) return null
        if (!isDecrease && now - lastPushAt < tuning.increasePushInterval) return null

        if (!isDecrease) status = status.copy(increases = status.increases + 1)
        bitrate = next
        lastPushAt = now
        return next
    }

    private companion object {
        fun floorWithin(ceiling: Int, floor: Int?): Int = min(max(0, floor ?: (ceiling / 2)), ceiling)
    }
}
