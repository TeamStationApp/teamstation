package app.teamstation.cameraman.encode

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import app.teamstation.cameraman.core.EncodedAudioFrame
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * AAC-LC encoding of the captured microphone stream.
 *
 * Emits raw access units with no ADTS header, because RTP `mpeg4-generic` carries bare AUs and a
 * client that receives ADTS-wrapped frames decodes seven bytes of header as audio.
 *
 * MediaCodec will accept a buffer of any length, unlike `AudioConverterFillComplexBuffer`, which
 * demands exactly 1024 samples. Feeding it whole frames anyway is deliberate: it makes the
 * presentation time of every access unit derivable rather than reported, so the RTP timestamps step
 * by exactly 1024 on both builds instead of tracking whatever size the microphone happened to hand
 * over.
 */
class AudioEncoder {
    sealed interface Failure {
        val description: String

        data class Converter(val reason: String) : Failure {
            override val description: String get() = "could not create an AAC converter ($reason)"
        }

        data class Unsupported(val sampleRate: Int, val channels: Int) : Failure {
            override val description: String
                get() = "AAC cannot express $sampleRate Hz / ${channels}ch"
        }
    }

    private val thread = HandlerThread("cameraman-audio").apply { start() }
    private val handler = Handler(thread.looper)
    private val lock = ReentrantLock()

    private var codec: MediaCodec? = null
    private var pcmPending = PCMPendingBuffer()
    private var pendingTime: Double = 0.0
    /**
     * Recent (presentation time, capture time) pairs from the microphone, one per read; see
     * [captureFor]. Kept as a short history because a frame is cut from a buffer that spans reads.
     */
    private val captureAnchors = ArrayDeque<Pair<Double, Double>>()
    /**
     * The codec's priming: a packet's decoded sound is the input from this long before the frame it
     * carries the time of. From the output format's `encoder-delay` when the codec states it.
     */
    private var encoderDelaySeconds = 0.0
    private var bytesPerSourceFrame = 0
    private var configuredSampleRate = 0
    private var configuredChannels = 0
    private var hasStartTime = false

    /** Input buffer indices MediaCodec has handed back and that have not been filled yet. */
    private val freeInputBuffers = LinkedBlockingQueue<Int>()

    /**
     * The `AudioSpecificConfig` for the SDP's `config=`. Known before the first packet, because it
     * depends only on the negotiated format.
     */
    private var audioSpecificConfigValue: ByteArray? = null

    val audioSpecificConfig: ByteArray? get() = lock.withLock { audioSpecificConfigValue }

    /** Bytes of PCM still waiting for a 1024-sample AAC frame. Soak telemetry reads this. */
    val pendingBytes: Int get() = lock.withLock { pcmPending.readableCount }

    var onFrame: ((EncodedAudioFrame) -> Unit)? = null
    var onFailure: ((Failure) -> Unit)? = null

    fun configure(sampleRate: Int, channelCount: Int) {
        handler.post {
            val config = AudioSpecificConfigBuilder.aacLC(sampleRate, channelCount)
            if (config == null) {
                onFailure?.invoke(Failure.Unsupported(sampleRate, channelCount))
                return@post
            }

            teardownLocked()

            try {
                val format = MediaFormat.createAudioFormat(
                    MediaFormat.MIMETYPE_AUDIO_AAC,
                    sampleRate,
                    channelCount
                ).apply {
                    setInteger(
                        MediaFormat.KEY_AAC_PROFILE,
                        MediaCodecInfo.CodecProfileLevel.AACObjectLC
                    )
                    // 64 kbps mono is transparent for a field microphone and is a rounding error
                    // next to six megabits of video.
                    setInteger(MediaFormat.KEY_BIT_RATE, 64_000 * channelCount)
                    setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, samplesPerFrame * 2 * channelCount)
                }

                val created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
                created.setCallback(callback, handler)
                created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                created.start()

                lock.withLock {
                    codec = created
                    configuredSampleRate = sampleRate
                    configuredChannels = channelCount
                    bytesPerSourceFrame = 2 * channelCount
                    // The config is written down here rather than read back from the codec's output
                    // format, because a client may DESCRIBE before the first packet is encoded and
                    // an SDP without `config=` is one no decoder can start from.
                    audioSpecificConfigValue = config
                    pcmPending.reset()
                    pendingTime = 0.0
                    hasStartTime = false
                    captureAnchors.clear()
                    encoderDelaySeconds = defaultEncoderDelaySamples.toDouble() / sampleRate.toDouble()
                }
                freeInputBuffers.clear()
            } catch (error: Exception) {
                onFailure?.invoke(Failure.Converter(error.message ?: error.javaClass.simpleName))
            }
        }
    }

    /**
     * PCM straight off the microphone. [presentationTime] is seconds on the capture clock.
     *
     * The bytes are copied here rather than retained, so the caller's `AudioRecord` buffer can be
     * reused on the very next read.
     */
    fun encode(pcm: ByteArray, count: Int, presentationTime: Double, captureTime: Double? = null) {
        if (count <= 0) return
        val copy = pcm.copyOf(count)
        handler.post {
            if (lock.withLock { codec } == null) return@post
            lock.withLock {
                if (captureTime != null) {
                    captureAnchors.addLast(presentationTime to captureTime)
                    while (captureAnchors.size > 16) captureAnchors.removeFirst()
                }
                if (pcmPending.readableCount == 0 || !hasStartTime) {
                    pendingTime = presentationTime
                    hasStartTime = true
                }
                pcmPending.append(copy)
            }
            dropIfBackedUp()
            drain()
            lock.withLock { pcmPending.compactIfNeeded() }
        }
    }

    fun invalidate() {
        handler.post { teardownLocked() }
    }

    /**
     * The codec needs a free input buffer and whole frames of PCM at the same moment, and a capture
     * callback delivers whatever the hardware felt like. Anything short of a frame is held over
     * rather than padded with silence, which would put a click into the stream at every buffer
     * boundary.
     */
    private fun drain() {
        val running = lock.withLock { codec } ?: return
        val perFrame = lock.withLock { samplesPerFrame * bytesPerSourceFrame }
        if (perFrame <= 0) return

        while (true) {
            val chunk = lock.withLock {
                if (pcmPending.readableCount < perFrame) null else pcmPending.take(perFrame)
            } ?: return

            val index = freeInputBuffers.poll()
            if (index == null) {
                // No input buffer to put it in. Push the frame back rather than dropping it: the
                // codec will hand a buffer back within a frame or two, and a hole in audio is far
                // more audible than a few milliseconds of added latency.
                lock.withLock { pcmPending.unread(chunk.size) }
                return
            }

            val time = lock.withLock { pendingTime }
            val timeMicros = (time * 1_000_000).toLong()
            try {
                val buffer = running.getInputBuffer(index) ?: return
                buffer.clear()
                buffer.put(chunk)
                running.queueInputBuffer(
                    index,
                    0,
                    chunk.size,
                    timeMicros,
                    0
                )
            } catch (error: Exception) {
                onFailure?.invoke(Failure.Converter(error.message ?: error.javaClass.simpleName))
                return
            }
            lock.withLock {
                pendingTime += samplesPerFrame.toDouble() / configuredSampleRate.toDouble()
            }
        }
    }

    /**
     * Capture time of the sample at presentation time [time]: the latest read at or before it, moved
     * by how far into that read [time] falls. Frames are cut from a buffer that spans reads, so the
     * newest read is not always the frame's own — and beside a stretch the system dropped, using it
     * would stamp the frame off by the whole drop.
     */
    private fun captureFor(time: Double): Double? = lock.withLock { captureAt(captureAnchors, time) }

    /**
     * Eight AAC frames is 170 ms of PCM. Anything more is the encoder falling behind, which is how
     * this buffer would otherwise grow at the microphone's byte rate until the process was killed.
     */
    private fun dropIfBackedUp() {
        lock.withLock {
            if (bytesPerSourceFrame <= 0 || configuredSampleRate <= 0) return
            val perFrame = samplesPerFrame * bytesPerSourceFrame
            val maxBytes = perFrame * maxBufferedFrames
            val extra = pcmPending.readableCount - maxBytes
            if (extra <= 0) return
            val drop = extra - (extra % perFrame)
            if (drop <= 0) return
            pcmPending.skip(drop)
            pendingTime += (drop / bytesPerSourceFrame).toDouble() / configuredSampleRate.toDouble()
            pcmPending.compactIfNeeded()
        }
    }

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
            if (lock.withLock { this@AudioEncoder.codec } !== codec) return
            freeInputBuffers.offer(index)
            drain()
        }

        override fun onOutputBufferAvailable(
            codec: MediaCodec,
            index: Int,
            info: MediaCodec.BufferInfo
        ) {
            if (lock.withLock { this@AudioEncoder.codec } !== codec) {
                runCatching { codec.releaseOutputBuffer(index, false) }
                return
            }
            try {
                // The codec-config buffer for AAC is the AudioSpecificConfig, which is already known
                // from the negotiated format. Emitting it as a frame would send two bytes of header
                // to a client as if they were audio.
                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) return
                if (info.size <= 0) return
                val buffer = codec.getOutputBuffer(index) ?: return
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                val bytes = ByteArray(info.size)
                buffer.get(bytes)

                val (rate, channels) = lock.withLock { configuredSampleRate to configuredChannels }
                // The packet's decoded sound is the input from the codec's delay before the frame
                // whose time it carries: stamped there, it plays with the pictures captured with it.
                val time = soundTime(info.presentationTimeUs, lock.withLock { encoderDelaySeconds })
                val capture = captureFor(time)
                onFrame?.invoke(
                    EncodedAudioFrame(
                        data = bytes,
                        presentationTime = time,
                        sampleRate = rate,
                        channelCount = channels,
                        captureTime = capture
                    )
                )
            } finally {
                runCatching { codec.releaseOutputBuffer(index, false) }
            }
        }

        override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
            onFailure?.invoke(Failure.Converter("${error.errorCode}: ${error.message}"))
        }

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            delaySamples(format)?.let { samples ->
                lock.withLock {
                    if (configuredSampleRate > 0) encoderDelaySeconds = samples / configuredSampleRate.toDouble()
                }
            }
        }
    }

    private fun teardownLocked() {
        val running = lock.withLock {
            val current = codec
            codec = null
            pcmPending.reset()
            pendingTime = 0.0
            hasStartTime = false
            captureAnchors.clear()
            encoderDelaySeconds = 0.0
            audioSpecificConfigValue = null
            current
        }
        freeInputBuffers.clear()
        if (running == null) return
        runCatching { running.stop() }
        runCatching { running.release() }
    }

    companion object {
        /** AAC-LC always codes 1024 samples per access unit, which is the RTP timestamp step. */
        const val samplesPerFrame = 1024

        /** Eight AAC frames is 170 ms of PCM. Anything more is the encoder falling behind. */
        private const val maxBufferedFrames = 8

        /**
         * AAC-LC priming in samples when the codec does not state its `encoder-delay`, as the Pixel
         * 10's `c2.android.aac.encoder` does not: measured there, encoded noise bursts decode (as
         * TS Director decodes, one access unit at a time) exactly 2,048 samples after their input.
         */
        const val defaultEncoderDelaySamples = 2048

        /** The time of a packet's decoded sound: the codec's output time less its priming. */
        fun soundTime(outputPresentationUs: Long, delaySeconds: Double): Double =
            outputPresentationUs / 1_000_000.0 - delaySeconds

        /**
         * Capture time of the sample at [time]: the latest anchor at or before it, moved by how far
         * past that anchor [time] falls, or the earliest anchor for a time before them all.
         */
        fun captureAt(anchors: Collection<Pair<Double, Double>>, time: Double): Double? {
            val anchor = anchors.lastOrNull { it.first <= time + 1e-6 } ?: anchors.firstOrNull()
            return anchor?.let { (presentation, capture) -> capture + (time - presentation) }
        }

        /** The codec's stated priming, in samples, if its output format carries one. */
        fun delaySamples(format: MediaFormat): Int? =
            if (format.containsKey(MediaFormat.KEY_ENCODER_DELAY)) format.getInteger(MediaFormat.KEY_ENCODER_DELAY) else null
    }
}
