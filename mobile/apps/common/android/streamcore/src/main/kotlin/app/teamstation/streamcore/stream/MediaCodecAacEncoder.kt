package app.teamstation.streamcore.stream

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import app.teamstation.streamcore.encode.AudioEncoder
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * AAC-LC at 128 kbps, 48 kHz stereo, on MediaCodec, used synchronously like TS Director's
 * `AACPacketizer`: [encode] hands the encoder whole 1024-sample frames and takes back whatever
 * packets it has finished.
 *
 * A codec holds on to its input buffers until it has encoded them, so one can have none free when a
 * frame is ready. [encode] then takes the codec's output, which frees them, and asks again, for up to
 * [inputWaitMicros]; whatever is still left waits for the next call, and [finish] queues it all before
 * it ends the stream.
 */
class MediaCodecAacEncoder(
    private val bitrate: Int = 128_000,
    /** How long one call waits for a buffer, in microseconds. */
    private val timeoutMicros: Long = 2_000,
    /** How long one call keeps asking a busy codec for input buffers, in microseconds. */
    private val inputWaitMicros: Long = 500_000
) : StreamAudioEncoding {
    private var codec: MediaCodec? = null
    private var leftover = ShortArray(0)
    private var queuedFrames = 0L

    /** Asks the codec for a free input buffer. Replaced in tests, to make a codec that is busy. */
    internal var dequeueInput: (MediaCodec, Long) -> Int = { running, timeout -> running.dequeueInputBuffer(timeout) }

    override var audioSpecificConfig: ByteArray = defaultAudioSpecificConfig
        private set

    override var primingSamples: Int = AudioEncoder.defaultEncoderDelaySamples
        private set

    override fun encode(samples: ShortArray): List<ByteArray> {
        leftover += samples
        val running = codec ?: open()
        val packets = mutableListOf<ByteArray>()
        queueWholeFrames(running, packets, inputWaitMicros)
        drain(running, packets)
        return packets
    }

    /**
     * Pads the last partial frame with silence, ends the stream and answers every packet still in
     * the encoder, so a recording's sound runs to its last sample. Frames an earlier [encode] could
     * not queue go first, so only what is short of a whole frame is padded.
     */
    override fun finish(): List<ByteArray> {
        val running = codec ?: return emptyList()
        val packets = mutableListOf<ByteArray>()
        val partial = leftover.size % frameSamples
        if (partial != 0) leftover += ShortArray(frameSamples - partial)
        queueWholeFrames(running, packets, maxOf(inputWaitMicros, timeoutMicros * 50))
        val index = dequeueInput(running, timeoutMicros * 50)
        if (index >= 0) {
            val time = queuedFrames * 1_000_000 / StreamAudioStamps.sampleRate
            running.queueInputBuffer(index, 0, 0, time, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        }
        drain(running, packets, untilEnd = true)
        leftover = ShortArray(0)
        return packets
    }

    /**
     * Queues every whole frame in [leftover]. A codec with no input buffer free has its output taken,
     * which frees one, and is asked again until [waitMicros] have passed.
     */
    private fun queueWholeFrames(running: MediaCodec, packets: MutableList<ByteArray>, waitMicros: Long) {
        val deadline = System.nanoTime() + waitMicros * 1_000
        while (leftover.size >= frameSamples) {
            val index = dequeueInput(running, timeoutMicros)
            if (index < 0) {
                drain(running, packets)
                if (System.nanoTime() >= deadline) return
                continue
            }
            val input = running.getInputBuffer(index) ?: continue
            val frame = leftover.copyOfRange(0, frameSamples)
            leftover = leftover.copyOfRange(frameSamples, leftover.size)
            input.clear()
            val bytes = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            bytes.asShortBuffer().put(frame)
            input.put(bytes)
            val time = queuedFrames * 1_000_000 / StreamAudioStamps.sampleRate
            running.queueInputBuffer(index, 0, frame.size * 2, time, 0)
            queuedFrames += StreamAudioStamps.samplesPerPacket
            drain(running, packets)
        }
    }

    private fun drain(running: MediaCodec, into: MutableList<ByteArray>, untilEnd: Boolean = false) {
        val info = MediaCodec.BufferInfo()
        val deadline = System.nanoTime() + 500_000_000L
        while (true) {
            val index = running.dequeueOutputBuffer(info, if (untilEnd) timeoutMicros else 0)
            if (untilEnd && index == MediaCodec.INFO_TRY_AGAIN_LATER && System.nanoTime() < deadline) continue
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                AudioEncoder.delaySamples(running.outputFormat)?.let { primingSamples = it }
                continue
            }
            if (index < 0) return
            val buffer = running.getOutputBuffer(index)
            if (buffer != null && info.size > 0) {
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                val bytes = ByteArray(info.size).also { buffer.get(it) }
                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                    audioSpecificConfig = bytes
                } else {
                    into += bytes
                }
            }
            running.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
        }
    }

    private fun open(): MediaCodec {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, StreamAudioStamps.sampleRate, channels).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, StreamAudioStamps.samplesPerPacket * channels * 2)
        }
        val created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        created.start()
        codec = created
        return created
    }

    override fun reset() {
        close()
        leftover = ShortArray(0)
        queuedFrames = 0
    }

    override fun close() {
        val running = codec ?: return
        codec = null
        runCatching { running.stop() }
        runCatching { running.release() }
    }

    companion object {
        const val channels = 2

        /** One AAC frame of interleaved stereo samples. */
        private const val frameSamples = StreamAudioStamps.samplesPerPacket * channels

        /** AAC-LC, 48 kHz, stereo. */
        val defaultAudioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
    }
}
