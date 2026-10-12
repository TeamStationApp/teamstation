package app.teamstation.streamcore.bitrate

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
