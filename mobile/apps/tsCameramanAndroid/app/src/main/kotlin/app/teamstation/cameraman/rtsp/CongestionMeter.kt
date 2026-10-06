package app.teamstation.cameraman.rtsp

import kotlin.math.max

/**
 * What one client's link did over one sampling interval, seen from the sending side.
 *
 * Every client is RTP interleaved on a single TCP connection, so a weak link never shows up as loss.
 * It shows up as bytes waiting on this side, and nothing comes back from the receiver to say
 * otherwise: Director sends no RTCP receiver reports. So these are the only congestion signals there
 * are, and they are all measured here.
 */
data class CongestionSample(
    /** Seconds since the previous sample of the same client. */
    val interval: Double,
    /** Age of the oldest media send the transport has not yet taken. Zero when nothing is waiting. */
    val queueDelay: Double = 0.0,
    /** Media bytes the transport took this interval. */
    val deliveredBytes: Int = 0,
    /**
     * Media bytes the encoder offered this client this interval, sent or dropped. Delivery can only
     * measure the link when this is more than the link can carry; otherwise it measures the encoder.
     */
    val offeredBytes: Int = 0,
    /** Bytes the transport holds that have not left, when the platform can say. Null otherwise. */
    val transportBacklogBytes: Int? = null,
    /**
     * Media bytes that left the transport this interval: [deliveredBytes] less whatever the
     * transport backlog grew by. The same as [deliveredBytes] when the backlog cannot be read.
     */
    val drainedBytes: Int = deliveredBytes,
    val droppedFrames: Int = 0,
    val flushes: Int = 0
) {
    companion object {
        /**
         * The client whose link is doing worst. One encoder feeds every client, so the rate has to
         * suit the weakest of them: a picture sized for the best link is dropped wholesale on the
         * worst.
         */
        fun worst(samples: List<CongestionSample>): CongestionSample? =
            samples.maxWithOrNull(
                compareBy<CongestionSample> { it.droppedFrames + it.flushes > 0 }
                    .thenBy { it.queueDelay }
            )
    }
}

/**
 * Keeps the ledger a [CongestionSample] is read from: every media send in order, and when the
 * transport took it.
 *
 * Sends complete in the order they were made, because the link is one TCP stream and one writer
 * thread. So the oldest unfinished send is always the first entry, and its age is how long the
 * newest frame will wait.
 *
 * Not thread-safe; the connection holds its lock around every call.
 */
class CongestionMeter {
    private val waitingSince = ArrayDeque<Double>()
    private val waitingBytes = ArrayDeque<Int>()

    private var deliveredSinceSample = 0
    private var offeredSinceSample = 0
    private var lastSampleTime: Double? = null
    private var lastDroppedFrames = 0
    private var lastFlushes = 0
    private var lastBacklog: Int? = null

    /** Bytes waiting in the ledger, which is this app's share of the backlog. */
    val pendingBytes: Int get() = waitingBytes.sum()

    /** A frame the encoder produced for this client, counted whether it is then sent or dropped. */
    fun offered(bytes: Int) {
        offeredSinceSample += bytes
    }

    fun sent(bytes: Int, time: Double) {
        waitingSince.addLast(time)
        waitingBytes.addLast(bytes)
    }

    /** The transport took the oldest outstanding send. */
    fun delivered() {
        val bytes = waitingBytes.removeFirstOrNull() ?: return
        waitingSince.removeFirst()
        deliveredSinceSample += bytes
    }

    fun queueDelay(now: Double): Double {
        val oldest = waitingSince.firstOrNull() ?: return 0.0
        return max(0.0, now - oldest)
    }

    /**
     * Everything since the previous call. [droppedFrames] and [flushes] are the send queue's running
     * totals; the sample carries how much each grew. [waitingHere] is how long the oldest media not
     * yet handed to the transport has waited, which counts toward the delay as much as the ledger's.
     */
    fun sample(
        now: Double,
        droppedFrames: Int,
        flushes: Int,
        transportBacklogBytes: Int? = null,
        waitingHere: Double = 0.0
    ): CongestionSample {
        val interval = lastSampleTime?.let { max(0.0, now - it) } ?: 0.0
        val previous = lastBacklog
        val drained = if (transportBacklogBytes != null && previous != null) {
            max(0, deliveredSinceSample - (transportBacklogBytes - previous))
        } else {
            deliveredSinceSample
        }
        val sample = CongestionSample(
            interval = interval,
            queueDelay = max(queueDelay(now), waitingHere),
            deliveredBytes = deliveredSinceSample,
            offeredBytes = offeredSinceSample,
            transportBacklogBytes = transportBacklogBytes,
            drainedBytes = drained,
            droppedFrames = max(0, droppedFrames - lastDroppedFrames),
            flushes = max(0, flushes - lastFlushes)
        )
        lastSampleTime = now
        lastDroppedFrames = droppedFrames
        lastFlushes = flushes
        lastBacklog = transportBacklogBytes
        deliveredSinceSample = 0
        offeredSinceSample = 0
        return sample
    }
}
