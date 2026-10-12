package app.teamstation.streamcore.stream

import kotlin.math.abs

/**
 * The stream's counted audio timestamps: TS Director's `ProgramStreamer` stamping helpers.
 *
 * An AAC packet is 1024 samples, which at 48 kHz is 21.333 ms, a duration that cannot be written in
 * the whole milliseconds RTMP carries. So it is counted rather than measured: the packet's index
 * times its true length from an epoch, rounded only at the last moment. The error stays under half a
 * millisecond for ever and never accumulates.
 */
object StreamAudioStamps {
    const val sampleRate = 48_000
    const val samplesPerPacket = 1024

    /** How long one packet of sound lasts: 1024 frames at 48 kHz. */
    const val packetSeconds = samplesPerPacket.toDouble() / sampleRate

    /**
     * How far the mix may drift from where the last frame ended before it counts as a break, after
     * which the encoder starts again from the next frame's own time.
     */
    const val audioGapResetSeconds = 0.01

    /** Whether a frame of mix starting at [wall] breaks from the one before, which ended at [expected]. */
    fun audioBreaks(expected: Double?, wall: Double): Boolean =
        expected != null && abs(wall - expected) > audioGapResetSeconds

    /**
     * The stamps that may go, in order: null for a packet with none, and for one at or before the
     * last stamp sent ([after]), or the one before it in this run.
     */
    fun monotonicAudioStamps(stamps: List<Long?>, after: Long?): List<Long?> {
        var last = after
        return stamps.map { stamp ->
            if (stamp == null || !(stamp > (last ?: 0) || last == null)) {
                null
            } else {
                last = stamp
                stamp
            }
        }
    }

    /**
     * Where packet 0's decoded sound plays on the stream's clock, in milliseconds, negative when that
     * is before the stream began: the first sample's wall clock less the stream's start, less the
     * encoder's priming.
     */
    fun audioEpochMilliseconds(inputWall: Double, startWall: Double, primingSamples: Int): Double =
        (inputWall - startWall - primingSamples.toDouble() / sampleRate) * 1_000

    /**
     * Timestamps, in milliseconds, for [count] packets from packet [from], counted from [epoch]. A
     * packet that would play before the stream began has none, and is not sent.
     */
    fun audioTimestamps(count: Int, from: Int, epoch: Double): List<Long?> {
        val packetMilliseconds = packetSeconds * 1000
        return (0 until count).map { offset ->
            val stamp = (epoch + (from + offset) * packetMilliseconds).roundedHalfAwayFromZero()
            if (stamp >= 0) stamp.toLong() else null
        }
    }
}
