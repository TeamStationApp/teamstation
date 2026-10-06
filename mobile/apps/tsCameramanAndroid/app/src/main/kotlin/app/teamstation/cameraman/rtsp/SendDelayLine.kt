package app.teamstation.cameraman.rtsp

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.random.Random

/**
 * Holds outgoing frames back so a receiver sees late delivery with an honest timestamp.
 *
 * Test-only. This is the fault the synchronisation design claims to absorb: a frame that arrives
 * after its display deadline but still carrying the capture time it was stamped with. Blanking a
 * source exercises none of that.
 *
 * `EncodedVideoFrame.presentationTime` is on the capture clock and the RTP timestamp is derived from
 * it at packetization, so holding a frame here changes *when* it arrives without touching *when it
 * says it was taken*. Nothing else is needed to keep the stamp truthful — and on this build that is
 * only true because the RTCP sender report is stamped from the capture time too; a report stamped at
 * send would slide with the delay and hide the very fault being injected.
 *
 * Three shapes, because they fail differently:
 *
 * - [delayMilliseconds] alone is the weak case. A constant offset is just added latency, and any
 *   correct receiver absorbs it without noticing. Useful only as a control.
 * - [jitterMilliseconds] spreads arrivals either side of the delay, which is what a lightly loaded
 *   link does.
 * - [burstMilliseconds] is the one that matters. Frames accumulate for the window and are released
 *   together, reproducing what Wi-Fi does under contention — measured 118–270 ms arrival gaps, the
 *   largest landing on keyframes. A design that survives constant delay can still fall over here.
 */
class SendDelayLine {
    private data class Pending(val due: Long, val sequence: Long, val deliver: () -> Unit)

    private val lock = ReentrantLock()
    private var delaySeconds = 0.0
    private var jitterSeconds = 0.0
    private var burstSeconds = 0.0
    private val pending = ArrayList<Pending>()
    private var nextSequence = 0L
    private var burstOpenedAt: Long? = null
    private var heldFrames = 0L
    private var isScheduled = false

    /**
     * The struggling-phone hold: given monotonic seconds now, when a packet handed over now may
     * leave, or null for at once. Holds every packet of both streams and releases them in a burst.
     */
    private var holdRelease: ((Double) -> Double?)? = null

    /**
     * True while a drain is handing frames on, outside the lock. A send arriving then waits its turn
     * rather than going out at once ahead of them, which reordered the first frames after a hold.
     */
    private var delivering = false

    fun setHoldRelease(release: ((Double) -> Double?)?) {
        lock.withLock { holdRelease = release }
    }

    private val queue: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "cameraman-senddelay").apply { isDaemon = true }
        }

    data class Summary(
        val delayMilliseconds: Double,
        val jitterMilliseconds: Double,
        val burstMilliseconds: Double,
        val held: Int,
        val totalHeld: Long
    )

    /**
     * The configuration and what is waiting, for telemetry. A run that reports zero held frames while
     * a delay is set has not actually injected anything, which is the failure a fault harness must
     * never report as a pass.
     */
    fun summary(): Summary = lock.withLock {
        Summary(
            delaySeconds * 1000,
            jitterSeconds * 1000,
            burstSeconds * 1000,
            pending.size,
            heldFrames
        )
    }

    val isActive: Boolean
        get() = lock.withLock { delaySeconds > 0 || jitterSeconds > 0 || burstSeconds > 0 }

    /**
     * All zeros restores immediate delivery and flushes anything still held, so a test can return
     * the camera to normal without restarting it.
     */
    fun configure(delayMilliseconds: Double, jitterMilliseconds: Double, burstMilliseconds: Double) {
        val draining = lock.withLock {
            delaySeconds = maxOf(0.0, delayMilliseconds) / 1000
            jitterSeconds = maxOf(0.0, jitterMilliseconds) / 1000
            burstSeconds = maxOf(0.0, burstMilliseconds) / 1000
            val idle = delaySeconds == 0.0 && jitterSeconds == 0.0 && burstSeconds == 0.0
            if (!idle) return@withLock emptyList()
            val held = pending.sortedBy { it.sequence }
            pending.clear()
            burstOpenedAt = null
            held
        }
        for (item in draining) item.deliver()
    }

    /** Routes one send. Returns at once either way; [deliver] runs now or later on the delay queue. */
    fun submit(deliver: () -> Unit) {
        val immediate = lock.withLock {
            val now = System.nanoTime()
            val held = holdRelease?.invoke(now / 1_000_000_000.0)
            if (delaySeconds <= 0 && jitterSeconds <= 0 && burstSeconds <= 0 && held == null && pending.isEmpty() && !delivering) {
                return@withLock true
            }

            // Jitter is symmetric about the delay and never pulls a frame earlier than the moment it
            // was handed over: a negative total would deliver out of order, a different fault.
            val spread = if (jitterSeconds > 0) {
                Random.nextDouble(-jitterSeconds, jitterSeconds)
            } else {
                0.0
            }
            var due = now + (maxOf(0.0, delaySeconds + spread) * 1_000_000_000).toLong()
            if (burstSeconds > 0) {
                val opened = burstOpenedAt ?: now
                burstOpenedAt = opened
                // Everything in this window leaves together at its end, which is the clumping.
                due = maxOf(due, opened + (burstSeconds * 1_000_000_000).toLong())
            }
            // While a hold is set, nothing overtakes what is already waiting: a packet after a hold
            // leaves with or after the hold's burst, never before it.
            if (holdRelease != null) pending.maxOfOrNull { it.due }?.let { due = maxOf(due, it) }
            if (held != null) due = maxOf(due, (held * 1_000_000_000).toLong())
            pending.add(Pending(due, nextSequence, deliver))
            nextSequence += 1
            heldFrames += 1
            scheduleLocked()
            false
        }
        if (immediate) deliver()
    }

    private fun scheduleLocked() {
        if (isScheduled) return
        val soonest = pending.minOfOrNull { it.due } ?: return
        isScheduled = true
        val delay = maxOf(0L, soonest - System.nanoTime())
        queue.schedule({ drain() }, delay, TimeUnit.NANOSECONDS)
    }

    private fun drain() {
        val ready = lock.withLock {
            isScheduled = false
            val now = System.nanoTime()
            // Sequence order, not due order: two frames sharing a burst deadline must still leave in
            // the order they were encoded, or the receiver sees reordering rather than lateness.
            val due = pending.filter { it.due <= now }.sortedBy { it.sequence }
            pending.removeAll { it.due <= now }
            if (pending.isEmpty()) burstOpenedAt = null
            scheduleLocked()
            delivering = true
            due
        }
        try {
            for (item in ready) item.deliver()
        } finally {
            lock.withLock { delivering = false }
        }
    }
}
