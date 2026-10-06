package app.teamstation.cameraman.rtsp

import kotlin.math.max

/**
 * What waits to go out to one client, and what is given up when the link falls behind.
 *
 * A camera encodes at a fixed rate whatever the network is doing. When the link carries less than
 * that, something has to wait, and whatever waits grows older. A receiver plays each picture and
 * each sound a fixed delay after capture (TS Director's live delay D, a second by default), so
 * anything that waits longer than that on the phone is too late to be heard or shown live, and holds
 * up everything behind it: on a link with jitter and loss a phone once fell 480 s behind, and at a
 * 3 Mbit/s cap it ran 0.5–1.4 s behind, so the live mix went silent for long stretches and replayed
 * a backlog when the link cleared.
 *
 * So nothing is allowed to wait longer than [maximumAge] from capture:
 *
 * - A picture older than that starts a drop: it and every picture after it up to the next keyframe
 *   are discarded (nothing between can be decoded without the dropped one), and the encoder is asked
 *   for a keyframe. The stream skips ahead instead of falling behind.
 * - Sound older than that is discarded. Its stamps follow capture position, so the receiver sees a
 *   gap in the sample count and fades over it on the same timeline.
 *
 * The wait has to happen here, where it can still be dropped. Bytes written to the socket cannot be
 * taken back, so the writer hands over only while [TransportGate] says the kernel holds less than
 * about a quarter second at the rate the link is draining it. Sound and control go in an urgent lane
 * ahead of pictures, and pictures go one RTP packet at a time, so sound never waits behind a whole
 * keyframe.
 *
 * RTP sequence numbers are written as packets are handed over, so a drop leaves no hole in them: a
 * receiver reads a hole as loss and marks the next access unit, the keyframe that ends the drop, as
 * corrupt.
 *
 * Not thread-safe; the connection holds its lock around every call. The iOS build's
 * `MediaSendQueue` is the same, line for line.
 */
class MediaSendQueue(val maximumAge: Double = maximumAgeSeconds) {
    private class Urgent(
        val data: ByteArray,
        /** Capture time on the capture clock; null for control. */
        val capture: Double?,
        val duration: Double,
        val enqueuedAt: Double
    )

    private class Picture(
        val packets: List<ByteArray>,
        val capture: Double,
        val isKeyframe: Boolean,
        val enqueuedAt: Double
    ) {
        var sent = 0
        val bytes: Int get() = packets.drop(sent).sumOf { it.size }
    }

    private val urgent = ArrayDeque<Urgent>()
    private val pictures = ArrayDeque<Picture>()
    private val sequences = HashMap<Int, Int>()
    private var lastKeyframeRequest: Double? = null

    /** True from a dropped picture until the keyframe that ends the drop. */
    var isDropping = false
        private set

    /** Pictures dropped for being too old, or for following one that was. */
    var droppedFrames = 0
        private set

    /** Drops started: each is one jump ahead in the picture. */
    var flushes = 0
        private set

    /** Sound packets dropped for being too old, and the sound they carried. */
    var droppedSoundPackets = 0
        private set
    var droppedSoundSeconds = 0.0
        private set

    /** Keyframes asked of the encoder by drops. */
    var keyframeRequests = 0
        private set

    /** A new session: what waits belongs to the old one. The counts and sequence numbers carry on. */
    fun reset() {
        urgent.clear()
        pictures.clear()
        isDropping = false
    }

    /** Bytes waiting here, not yet handed to the transport. */
    val pendingBytes: Int get() = urgent.sumOf { it.data.size } + pictures.sumOf { it.bytes }

    val isEmpty: Boolean get() = urgent.isEmpty() && pictures.isEmpty()

    /** How long the oldest thing waiting has waited here. */
    fun oldestWait(now: Double): Double {
        val first = listOfNotNull(urgent.firstOrNull()?.enqueuedAt, pictures.firstOrNull()?.enqueuedAt).minOrNull()
            ?: return 0.0
        return max(0.0, now - first)
    }

    /** The sequence number the next media packet on [channel] will carry, for `RTP-Info`. */
    fun nextSequence(channel: Int): Int = sequences[channel] ?: 0

    /** One picture, as interleaved RTP packets. Returns true when the encoder should be asked for a keyframe. */
    fun enqueuePicture(packets: List<ByteArray>, capture: Double, isKeyframe: Boolean, now: Double): Boolean {
        if (packets.isEmpty()) return false
        if (isDropping && !isKeyframe) {
            droppedFrames += 1
            return requestKeyframe(now)
        }
        // A drop leaves nothing unsent behind it but a picture already part-sent, so a keyframe simply
        // ends it.
        if (isKeyframe) isDropping = false
        pictures.addLast(Picture(packets, capture, isKeyframe, now))
        return prune(now)
    }

    /** One sound packet, as an interleaved RTP packet carrying [duration] seconds. */
    fun enqueueSound(packet: ByteArray, capture: Double, duration: Double, now: Double) {
        urgent.addLast(Urgent(packet, capture, duration, now))
    }

    /** A sender report or an RTSP response: never dropped, never renumbered, and ahead of pictures. */
    fun enqueueControl(data: ByteArray, now: Double) {
        urgent.addLast(Urgent(data, null, 0.0, now))
    }

    /** Drops what has grown too old. Returns true when the encoder should be asked for a keyframe. */
    fun prune(now: Double): Boolean {
        urgent.removeAll { item ->
            val capture = item.capture ?: return@removeAll false
            if (now - capture <= maximumAge) return@removeAll false
            droppedSoundPackets += 1
            droppedSoundSeconds += item.duration
            true
        }

        // A picture already part-sent finishes; the receiver has its first packets.
        val first = if ((pictures.firstOrNull()?.sent ?: 0) > 0) 1 else 0
        var stale = 0
        while (first + stale < pictures.size && now - pictures[first + stale].capture > maximumAge) stale += 1
        if (stale == 0 && !isDropping) return false
        if (!isDropping) flushes += 1
        // Everything up to the first keyframe young enough to send.
        var resume = first + stale
        while (resume < pictures.size && !pictures[resume].isKeyframe) resume += 1
        val found = resume < pictures.size
        droppedFrames += resume - first
        repeat(resume - first) { pictures.removeAt(first) }
        isDropping = !found
        return isDropping && requestKeyframe(now)
    }

    /**
     * The next bytes to hand to the transport, or null when there is nothing or no room. [hasRoom]
     * gates media; control always goes. Call [prune] first.
     */
    fun next(hasRoom: Boolean): Next? {
        val head = urgent.firstOrNull()
        if (head != null) {
            if (head.capture != null && !hasRoom) return null
            urgent.removeFirst()
            return if (head.capture == null) Next(head.data, false) else Next(renumbered(head.data), true)
        }
        if (!hasRoom) return null
        val picture = pictures.firstOrNull() ?: return null
        val packet = picture.packets[picture.sent]
        picture.sent += 1
        if (picture.sent == picture.packets.size) pictures.removeFirst()
        return Next(renumbered(packet), true)
    }

    /** An immutable reading, for the HUD and the state dump. */
    fun snapshot(): Snapshot = Snapshot(pendingBytes, droppedFrames, flushes, isDropping, droppedSoundSeconds)

    data class Snapshot(
        val pendingBytes: Int,
        val droppedFrames: Int,
        val flushes: Int,
        val isDropping: Boolean,
        val droppedSoundSeconds: Double
    )

    /** Bytes for the transport, and whether they are media (counted as sent) or control. */
    class Next(val bytes: ByteArray, val isMedia: Boolean)

    private fun requestKeyframe(now: Double): Boolean {
        val last = lastKeyframeRequest
        if (last != null && now - last < keyframeRequestIntervalSeconds) return false
        lastKeyframeRequest = now
        keyframeRequests += 1
        return true
    }

    /**
     * Writes the channel's next sequence number into an interleaved RTP packet (`$`, channel, length,
     * then the RTP header, whose sequence number is bytes 2–3).
     */
    private fun renumbered(framed: ByteArray): ByteArray {
        if (framed.size < 8 || framed[0] != 0x24.toByte()) return framed
        val channel = framed[1].toInt() and 0xFF
        val sequence = sequences[channel] ?: 0
        val data = framed.copyOf()
        data[6] = (sequence shr 8).toByte()
        data[7] = (sequence and 0xFF).toByte()
        sequences[channel] = (sequence + 1) and 0xFFFF
        return data
    }

    companion object {
        /**
         * The oldest capture anything may have when it is handed to the transport: TS Director's
         * default live delay D. Anything older cannot be heard or shown live, and sending it only
         * delays what is behind it.
         */
        const val maximumAgeSeconds = 1.0

        /** How often a drop may ask the encoder again for a keyframe that has not come. */
        const val keyframeRequestIntervalSeconds = 0.5
    }
}

/**
 * How much is in the transport — handed over, not yet gone from the phone — and whether more may
 * follow.
 *
 * A write returns once the kernel has the bytes, and the kernel's send buffer can hold seconds of
 * video at a weak link's rate, none of which can be dropped. So the transport is allowed about
 * [transportSeconds] of what the link is actually draining, never less than [minimumBytes] (a round
 * trip's worth on a healthy link) and [initialBytes] until a rate has been measured.
 */
class TransportGate {
    /** Bytes handed to the transport, and bytes it reported taking. */
    var handedBytes = 0L
        private set
    var processedBytes = 0L
        private set
    private val departures = ArrayDeque<Pair<Double, Long>>()

    /** Bytes per second the link has been draining, null until half a window is measured. */
    var drainRate: Double? = null
        private set

    fun handed(bytes: Int) {
        handedBytes += bytes
    }

    fun processed(bytes: Int) {
        processedBytes += bytes
    }

    /** Bytes the transport holds: handed and not yet taken, plus what the kernel holds. */
    fun inTransport(kernelBacklog: Int): Long = max(0L, handedBytes - processedBytes) + max(0, kernelBacklog)

    /** Notes how much has left the phone by [now], for the drain rate. */
    fun observe(now: Double, kernelBacklog: Int) {
        val left = max(0L, processedBytes - max(0, kernelBacklog))
        val last = departures.lastOrNull()
        if (last != null && now <= last.first) return
        departures.addLast(now to left)
        while (departures.size > 2 && now - departures[1].first >= rateWindowSeconds) departures.removeFirst()
        val oldest = departures.first()
        if (now - oldest.first >= rateWindowSeconds * 0.5) {
            drainRate = max(0L, left - oldest.second) / (now - oldest.first)
        }
    }

    val budgetBytes: Int
        get() {
            val rate = drainRate ?: return initialBytes
            return max(minimumBytes, (rate * transportSeconds).toInt())
        }

    fun hasRoom(kernelBacklog: Int): Boolean = inTransport(kernelBacklog) < budgetBytes

    companion object {
        const val transportSeconds = 0.25
        const val minimumBytes = 32 * 1024
        const val initialBytes = 64 * 1024
        const val rateWindowSeconds = 1.0
    }
}
