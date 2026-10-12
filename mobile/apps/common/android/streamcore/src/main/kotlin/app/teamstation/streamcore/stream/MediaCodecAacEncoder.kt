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
 */
class MediaCodecAacEncoder(
    private val bitrate: Int = 128_000,
    /** How long one call waits for a buffer, in microseconds. */
    private val timeoutMicros: Long = 2_000
) : StreamAudioEncoding {
    private var codec: MediaCodec? = null
    private var leftover = ShortArray(0)
    private var queuedFrames = 0L

    override var audioSpecificConfig: ByteArray = defaultAudioSpecificConfig
        private set

    override var primingSamples: Int = AudioEncoder.defaultEncoderDelaySamples
        private set

    override fun encode(samples: ShortArray): List<ByteArray> {
        leftover += samples
        val running = codec ?: open()
        val needed = StreamAudioStamps.samplesPerPacket * channels
        val packets = mutableListOf<ByteArray>()
        while (leftover.size >= needed) {
            val index = running.dequeueInputBuffer(timeoutMicros)
            if (index < 0) break
            val frame = leftover.copyOfRange(0, needed)
            leftover = leftover.copyOfRange(needed, leftover.size)
            val input = running.getInputBuffer(index) ?: continue
            input.clear()
            val bytes = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            bytes.asShortBuffer().put(frame)
            input.put(bytes)
            val time = queuedFrames * 1_000_000 / StreamAudioStamps.sampleRate
            running.queueInputBuffer(index, 0, frame.size * 2, time, 0)
            queuedFrames += StreamAudioStamps.samplesPerPacket
            drain(running, packets)
        }
        drain(running, packets)
        return packets
    }

    /**
     * Pads the last partial frame with silence, ends the stream and answers every packet still in
     * the encoder, so a recording's sound runs to its last sample.
     */
    override fun finish(): List<ByteArray> {
        val running = codec ?: return emptyList()
        val packets = mutableListOf<ByteArray>()
        val needed = StreamAudioStamps.samplesPerPacket * channels
        if (leftover.isNotEmpty()) packets += encode(ShortArray(needed - leftover.size))
        val index = running.dequeueInputBuffer(timeoutMicros * 50)
        if (index >= 0) {
            val time = queuedFrames * 1_000_000 / StreamAudioStamps.sampleRate
            running.queueInputBuffer(index, 0, 0, time, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        }
        drain(running, packets, untilEnd = true)
        return packets
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

        /** AAC-LC, 48 kHz, stereo. */
        val defaultAudioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
    }
}
