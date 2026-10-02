package app.teamstation.cameraman.capture

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaRecorder
import app.teamstation.cameraman.encode.AudioEncoder

/**
 * The microphone, read on its own thread.
 *
 * On iOS the microphone is another input on the same `AVCaptureSession`, so audio and video share
 * one clock and arrive through one delegate. Android has no such thing: `AudioRecord` is a separate
 * device on a separate clock, so this is a separate source and the two are only ever aligned by
 * RTCP — which is exactly what the sender reports exist for, and why they are not optional here.
 *
 * Its own timeline is counted in samples rather than read off a clock. `AudioRecord` delivers in
 * bursts, so timestamping on arrival would put scheduling jitter straight into the RTP timestamps
 * and a receiver would hear it as wow.
 *
 * `VOICE_RECOGNITION` rather than `MIC`: the default source applies whatever noise suppression and
 * automatic gain the handset ships with, which pumps badly on crowd noise and is the wrong choice
 * for a camera on a field. `VOICE_RECOGNITION` is the documented source with that processing off.
 */
class MicrophoneSource(private val encoder: AudioEncoder) {
    private var record: AudioRecord? = null
    private var thread: Thread? = null

    @Volatile
    private var running = false

    var onFailure: ((String) -> Unit)? = null

    @SuppressLint("MissingPermission")
    fun start(sampleRate: Int, channelCount: Int) {
        stop()

        val channelMask = if (channelCount >= 2) {
            AudioFormat.CHANNEL_IN_STEREO
        } else {
            AudioFormat.CHANNEL_IN_MONO
        }
        val minimum = AudioRecord.getMinBufferSize(
            sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minimum <= 0) {
            onFailure?.invoke("the microphone does not support $sampleRate Hz / ${channelCount}ch")
            return
        }
        // Four times the minimum: enough that a scheduling hiccup does not overrun the hardware
        // buffer, small enough that the added latency stays under a video frame.
        val bufferBytes = minimum * 4

        val created = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                channelMask,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes
            )
        } catch (error: Exception) {
            onFailure?.invoke("could not open the microphone: ${error.message}")
            return
        }

        if (created.state != AudioRecord.STATE_INITIALIZED) {
            created.release()
            onFailure?.invoke("the microphone did not initialise")
            return
        }

        record = created
        running = true
        created.startRecording()

        val bytesPerFrame = 2 * channelCount
        // One AAC frame per read, so the encoder never has to hold a partial one and the
        // presentation times line up with the access units exactly.
        val chunkBytes = AudioEncoder.samplesPerFrame * bytesPerFrame
        var framesRead = 0L

        thread = Thread({
            val buffer = ByteArray(chunkBytes)
            val stamp = AudioTimestamp()
            while (running) {
                val read = created.read(buffer, 0, buffer.size)
                if (read <= 0) {
                    if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_BAD_VALUE) {
                        onFailure?.invoke("microphone read failed ($read)")
                        return@Thread
                    }
                    continue
                }
                // Derived from the sample count rather than read from the clock: `AudioRecord`
                // delivers in bursts, and timestamping on arrival would put that jitter straight
                // into the RTP timestamps.
                val presentationTime = framesRead.toDouble() / sampleRate.toDouble()
                // And, beside it, when those samples were actually captured. The sample count alone
                // cannot know about samples the system dropped when this thread fell behind, so every
                // stamp after a drop is early; `AudioRecord`'s own timestamp can, and the sender
                // report pairs the two so the receiver places audio by the real time.
                val captureTime =
                    if (created.getTimestamp(stamp, AudioTimestamp.TIMEBASE_BOOTTIME) == AudioRecord.SUCCESS) {
                        captureSeconds(stamp.nanoTime, stamp.framePosition, framesRead, sampleRate)
                    } else {
                        null
                    }
                encoder.encode(buffer, read, presentationTime, captureTime)
                framesRead += read / bytesPerFrame
            }
        }, "cameraman-mic").apply {
            priority = Thread.MAX_PRIORITY
            isDaemon = true
            start()
        }
    }

    companion object {
        /**
         * When sample [framesRead] was captured, in boot-clock seconds, from a timestamp that says
         * sample [framePosition] was captured at [nanoTime]. Boot clock because the camera stamps
         * video frames on it, so audio and video share one mapping to wall time.
         */
        fun captureSeconds(nanoTime: Long, framePosition: Long, framesRead: Long, sampleRate: Int): Double =
            nanoTime / 1_000_000_000.0 + (framesRead - framePosition).toDouble() / sampleRate.toDouble()
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
        record?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        record = null
    }
}
