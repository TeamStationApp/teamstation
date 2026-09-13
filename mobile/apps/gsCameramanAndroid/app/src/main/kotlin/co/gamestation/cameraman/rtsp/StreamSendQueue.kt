package co.gamestation.cameraman.rtsp

import kotlin.math.max

/**
 * Decides what to drop when a client cannot keep up.
 *
 * A camera encodes at a fixed rate whatever the network is doing. Without this, a client on a weak
 * link makes the app's memory grow until it is killed, and the stream it eventually receives is
 * minutes stale. Dropping to the next keyframe instead keeps latency bounded and recovers cleanly,
 * because a keyframe is the one place a decoder can resynchronise.
 */
class StreamSendQueue(val highWaterMark: Int = defaultHighWaterMark) {
    enum class Decision {
        SEND,

        /** Queue is over budget and this frame is not a keyframe, so it is discarded. */
        DROP,

        /**
         * Queue is over budget and this is a keyframe, so the backlog is discarded and this frame
         * becomes the new start point.
         */
        FLUSH_THEN_SEND
    }

    var pendingBytes: Int = 0
        private set
    var droppedFrames: Int = 0
        private set
    var flushes: Int = 0
        private set

    /**
     * Bumped on [Decision.FLUSH_THEN_SEND]. Completions from sends queued before the flush must not
     * debit the new keyframe; bytes already handed to the socket cannot be retracted.
     */
    var generation: Int = 0
        private set

    /**
     * True between a drop and the keyframe that ends it. Only whole frames are ever dropped, but a
     * receiver still needs to know the picture sequence was broken.
     */
    var isDropping: Boolean = false
        private set

    fun decide(frameBytes: Int, isKeyframe: Boolean): Decision {
        if (pendingBytes <= highWaterMark) {
            // What follows a dropped picture predicts from it, directly or through the pictures
            // between, so it cannot be decoded either. Sent anyway, a receiver records frames nobody
            // can play: rec-351's Pixel export held them in 13 places. Only a keyframe ends a drop,
            // however much room the queue has.
            if (isDropping && !isKeyframe) {
                droppedFrames += 1
                return Decision.DROP
            }
            isDropping = false
            pendingBytes += frameBytes
            return Decision.SEND
        }

        if (isKeyframe) {
            flushes += 1
            isDropping = false
            generation += 1
            // The backlog is abandoned, so only this frame is outstanding.
            pendingBytes = frameBytes
            return Decision.FLUSH_THEN_SEND
        }

        droppedFrames += 1
        isDropping = true
        return Decision.DROP
    }

    /**
     * Called when the transport reports bytes have left, which is the only honest measure of what
     * the client has taken. A queue credited on enqueue rather than completion never reports
     * backpressure.
     *
     * Pass the [generation] captured at send time. Completions from a flushed generation are
     * ignored so they cannot subtract from the keyframe that replaced them.
     */
    fun complete(bytes: Int, generation: Int? = null) {
        if (generation != null && generation != this.generation) return
        pendingBytes = max(0, pendingBytes - bytes)
    }

    /**
     * Audio is never dropped. It is a few percent of the bitrate, and a gap in it is far more
     * noticeable than a dropped picture.
     */
    fun enqueueAudio(bytes: Int) {
        pendingBytes += bytes
    }

    /** An immutable reading, for the HUD and the state dump. */
    fun snapshot(): Snapshot = Snapshot(pendingBytes, droppedFrames, flushes, isDropping)

    data class Snapshot(
        val pendingBytes: Int,
        val droppedFrames: Int,
        val flushes: Int,
        val isDropping: Boolean
    )

    companion object {
        /**
         * Roughly half a second at 6 Mbps. Small enough that a recovered client is near-live rather
         * than replaying a backlog, large enough to absorb an ordinary Wi-Fi hiccup.
         */
        const val defaultHighWaterMark = 384 * 1024
    }
}
