package app.teamstation.streamcore.stream

/**
 * When a picture the RTMP client dropped while it waits for a keyframe may ask the encoder for one.
 * A port of TS Director's `ShedKeyframeRequest`.
 *
 * A shed that leaves no picture queued makes the client drop pictures until a keyframe arrives
 * (`DROPPED_AWAITING_KEYFRAME`). While the link is still stuck, that keyframe is shed in its turn and
 * the wait starts again, so asking on every drop makes every picture an IDR. One request a second is
 * enough to resume on: once the link takes pictures again, the next request is at most a second away.
 */
class ShedKeyframeRequest {
    private var lastRequest: Double? = null

    /**
     * Whether a drop at [now] should ask for a keyframe, noting the request when it should. A clock
     * that stepped back since the last request counts as a second later, not as a wait.
     */
    fun shouldRequest(now: Double): Boolean {
        val last = lastRequest
        if (last != null && now >= last && now - last < MINIMUM_INTERVAL) return false
        lastRequest = now
        return true
    }

    companion object {
        /** The shortest time between two requests, in seconds. */
        const val MINIMUM_INTERVAL = 1.0
    }
}
