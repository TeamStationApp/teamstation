package app.teamstation.streamcore.rtmp

import app.teamstation.streamcore.bitrate.CongestionSample

/**
 * The ledger a [CongestionSample] is read from: every write the client makes, in order, and how much
 * of it the socket has taken. A port of TS Director's `RTMPSendLedger`.
 *
 * Writes reach the socket in the order they were made, so the oldest write the socket has not
 * finished taking is always the first entry, and its age is how long the newest frame will wait.
 * Entries are made where [RTMPClient] counts a write as queued, when it is submitted, so the age
 * covers a backlog parked behind a blocked send.
 *
 * Commands and metadata go through the ledger too, so the bytes it counts delivered balance with what
 * the socket took. What the encoder offered counts media only.
 */
internal class RTMPSendLedger {
    private var waitingSince = ArrayList<Double>()
    private var waitingBytes = ArrayList<Int>()
    private var head = 0

    private var deliveredSinceSample = 0
    private var offeredVideoSinceSample = 0
    private var offeredAudioSinceSample = 0
    private var lastSampleTime: Double? = null
    private var lastDroppedPackets = 0L
    private var lastBacklog: Int? = null

    /** Bytes submitted and not yet taken by the socket. */
    val pendingBytes: Int get() = (head until waitingBytes.size).sumOf { waitingBytes[it] }

    /** A write of [bytes] was submitted at [time]. */
    fun submitted(bytes: Int, time: Double) {
        if (bytes <= 0) return
        waitingSince.add(time)
        waitingBytes.add(bytes)
    }

    /** The socket took [bytes] more, which may finish several writes or only part of one. */
    fun delivered(bytes: Int) {
        deliveredSinceSample += bytes
        var remaining = bytes
        while (remaining > 0 && head < waitingBytes.size) {
            val taken = minOf(remaining, waitingBytes[head])
            waitingBytes[head] -= taken
            remaining -= taken
            if (waitingBytes[head] == 0) head += 1
        }
        // Compacted in batches, so a long run does not grow the lists for ever and finishing a write
        // is not a shift of the whole list.
        if (head >= 256 && head * 2 >= waitingBytes.size) {
            waitingSince = ArrayList(waitingSince.subList(head, waitingSince.size))
            waitingBytes = ArrayList(waitingBytes.subList(head, waitingBytes.size))
            head = 0
        }
    }

    /**
     * A media tag handed to the client, whether it was then sent or shed. Audio is kept apart so it
     * can be taken out of the delivery rate: the controller sets the video bitrate.
     */
    fun offered(bytes: Int, isAudio: Boolean) {
        if (isAudio) offeredAudioSinceSample += bytes else offeredVideoSinceSample += bytes
    }

    /**
     * What is still waiting, after the queue has thrown some of it away. The shed writes are never
     * delivered, so their entries would otherwise sit at the head for ever and the queue delay would
     * climb without end, which is itself what triggers shedding.
     */
    fun resetWaiting(bytes: List<Int>, since: List<Double>) {
        waitingBytes = ArrayList(bytes)
        waitingSince = ArrayList(since)
        head = 0
    }

    /** The connection is gone and every write with it. */
    fun clear() {
        waitingSince.clear()
        waitingBytes.clear()
        head = 0
    }

    fun queueDelay(now: Double): Double =
        if (head < waitingSince.size) maxOf(0.0, now - waitingSince[head]) else 0.0

    /**
     * Everything since the previous call, in video's terms. [droppedPackets] is the client's running
     * total; the sample carries how much it grew. [transportBacklogBytes] is what the kernel holds
     * unsent, when it can be read. The audio offered in the interval is taken out of what was
     * delivered and drained.
     */
    fun sample(now: Double, droppedPackets: Long, transportBacklogBytes: Int?): CongestionSample {
        val interval = lastSampleTime?.let { maxOf(0.0, now - it) } ?: 0.0
        var drained = deliveredSinceSample
        val previous = lastBacklog
        if (transportBacklogBytes != null && previous != null) {
            drained = maxOf(0, deliveredSinceSample - (transportBacklogBytes - previous))
        }
        val audio = offeredAudioSinceSample
        val grown = droppedPackets - minOf(droppedPackets, lastDroppedPackets)
        val sample = CongestionSample(
            interval = interval,
            queueDelay = queueDelay(now),
            deliveredBytes = maxOf(0, deliveredSinceSample - audio),
            offeredBytes = offeredVideoSinceSample,
            transportBacklogBytes = transportBacklogBytes,
            drainedBytes = maxOf(0, drained - audio),
            droppedFrames = minOf(grown, Int.MAX_VALUE.toLong()).toInt(),
            flushes = 0
        )
        lastSampleTime = now
        lastDroppedPackets = droppedPackets
        lastBacklog = transportBacklogBytes
        deliveredSinceSample = 0
        offeredVideoSinceSample = 0
        offeredAudioSinceSample = 0
        return sample
    }
}
