package app.teamstation.streamcore.capture

import app.teamstation.streamcore.encode.AudioEncoder
import kotlin.math.roundToLong

/**
 * Feeds the AAC encoder silence at the sample rate, so a muted camera still has an audio track.
 *
 * Muting by stopping the encoder would leave a hole, and Director reads a hole in audio the same way
 * it reads a hole in video: as a source that went away. A continuous track of zeros is a camera that
 * is deliberately quiet, which is a different thing and the one an operator means.
 *
 * **Where this diverges from the iOS build, and why.** There, muting keeps the capture session's
 * audio input running and replaces the samples with zeros. Doing that here would hold `AudioRecord`
 * open, which keeps the microphone privacy indicator lit and obliges the foreground service to keep
 * claiming the microphone type — telling the operator, and the platform, that a muted camera is
 * listening. Synthesising the zeros instead produces the same bytes on the wire and holds nothing.
 */
class SilenceSource(private val encoder: AudioEncoder) {
    private var thread: Thread? = null

    @Volatile
    private var running = false

    fun start(sampleRate: Int, channelCount: Int) {
        stop()
        running = true
        val bytesPerFrame = 2 * channelCount
        val chunk = ByteArray(AudioEncoder.samplesPerFrame * bytesPerFrame)
        // One access unit's worth per tick, so the encoder sees exactly the cadence a microphone
        // would have produced and the RTP timestamps step by 1024 as they do when it is live.
        val periodNanos = (AudioEncoder.samplesPerFrame.toDouble() / sampleRate * 1_000_000_000)
            .roundToLong()

        thread = Thread({
            var framesWritten = 0L
            val start = System.nanoTime()
            while (running) {
                val presentationTime = framesWritten.toDouble() / sampleRate.toDouble()
                encoder.encode(chunk, chunk.size, presentationTime)
                framesWritten += AudioEncoder.samplesPerFrame
                // Paced against the start rather than by sleeping a period each time, so the track
                // does not drift by the accumulated cost of a thousand wake-ups.
                val due = start + framesWritten.toDouble() / sampleRate * 1_000_000_000
                val remaining = due.toLong() - System.nanoTime()
                if (remaining > 0) {
                    runCatching {
                        Thread.sleep(remaining / 1_000_000, (remaining % 1_000_000).toInt())
                    }
                }
            }
        }, "cameraman-silence").apply {
            isDaemon = true
            start()
        }
        // Referenced so the period is not computed and discarded on a build without assertions.
        check(periodNanos > 0)
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
    }
}
