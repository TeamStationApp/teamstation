package app.teamstation.streamcore.stream

/**
 * A run of the programme mix: interleaved 16-bit PCM at [sampleRate], and the wall-clock second its
 * first sample was captured. TS Director's `AudioFrame` for the stream and the recording.
 */
class AudioFrame(
    val samples: ShortArray,
    val wallClock: Double,
    val channels: Int = 2,
    val sampleRate: Int = StreamAudioStamps.sampleRate
) {
    /** Sample frames, one per channel group. */
    val frameCount: Int get() = samples.size / maxOf(channels, 1)

    val durationSeconds: Double get() = frameCount.toDouble() / sampleRate
}
