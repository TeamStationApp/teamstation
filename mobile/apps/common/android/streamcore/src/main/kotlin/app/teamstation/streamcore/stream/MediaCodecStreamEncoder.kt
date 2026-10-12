package app.teamstation.streamcore.stream

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.encode.NALUnitConversion
import app.teamstation.streamcore.encode.ParameterSets
import app.teamstation.streamcore.encode.VideoEncoder
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The stream's MediaCodec encoder, the counterpart of TS Director's stream `VTCompressionSession`:
 * a constant rate at the adaptive target, the settings' GOP, no B-frames, real-time priority, and
 * pictures through an input surface.
 *
 * Two MediaCodec keys stand in for what TS Director does per picture: `KEY_MAX_FPS_TO_ENCODER` holds
 * the encoder to the stream's frame rate whatever the camera delivers, and
 * `KEY_REPEAT_PREVIOUS_FRAME_AFTER` re-encodes the last picture when no new one has come, which is
 * what an idle IDR needs to have a picture to be.
 */
class MediaCodecStreamEncoder(
    /** False opens the codec for buffer input, which tests feed through [codecForTesting]. */
    private val surfaceInput: Boolean = true
) : StreamVideoEncoding {
    private val lock = ReentrantLock()
    private var thread: HandlerThread? = null
    private var codec: MediaCodec? = null
    private var activeCodec = StreamCodec.HEVC
    private var parameterSets: List<ByteArray> = emptyList()
    private var output: StreamVideoEncoding.Output? = null

    /** Input buffers a buffer-input session has offered, for tests to fill. */
    private val freeInputs = java.util.concurrent.LinkedBlockingQueue<Int>()

    /** Counted down when the session's end of stream comes out, after [finishInput]. */
    private var ended: java.util.concurrent.CountDownLatch? = null

    override fun open(config: StreamEncoderConfig, output: StreamVideoEncoding.Output): Surface? {
        close()
        val handlerThread = HandlerThread("stream-encode").apply { start() }
        val created = MediaCodec.createEncoderByType(config.codec.mimeType)
        lock.withLock {
            thread = handlerThread
            codec = created
            activeCodec = config.codec
            parameterSets = emptyList()
            this.output = output
        }
        created.setCallback(Callback(created), Handler(handlerThread.looper))
        created.configure(format(config, surfaceInput), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = if (surfaceInput) created.createInputSurface() else null
        created.start()
        return surface
    }

    override fun requestSyncFrame() {
        val running = lock.withLock { codec } ?: return
        runCatching { running.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
    }

    override fun setBitrate(bitrate: Int) {
        val running = lock.withLock { codec } ?: return
        runCatching { running.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bitrate) }) }
    }

    override fun finishInput(timeoutMillis: Long) {
        val latch = java.util.concurrent.CountDownLatch(1)
        val running = lock.withLock {
            ended = latch
            codec
        } ?: return
        if (runCatching { running.signalEndOfInputStream() }.isFailure) return
        latch.await(timeoutMillis, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    override fun close() {
        val (running, handlerThread) = lock.withLock {
            val current = codec to thread
            codec = null
            thread = null
            output = null
            current
        }
        running?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        handlerThread?.quitSafely()
    }

    /** Queues one access unit into a buffer-input session, as a test's stand-in for a camera. */
    internal fun queueForTesting(bytes: ByteArray, presentationTimeUs: Long, flags: Int = 0) {
        val running = lock.withLock { codec } ?: return
        val index = freeInputs.poll(2, java.util.concurrent.TimeUnit.SECONDS) ?: return
        running.getInputBuffer(index)?.apply {
            clear()
            put(bytes)
        }
        running.queueInputBuffer(index, 0, bytes.size, presentationTimeUs, flags)
    }

    private inner class Callback(private val owner: MediaCodec) : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
            // Surface input fills the buffers itself; a buffer-input session keeps them for a test.
            if (!surfaceInput) freeInputs.put(index)
        }

        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            val (current, sink) = lock.withLock { this@MediaCodecStreamEncoder.codec to output }
            try {
                if (current === owner) {
                    val bytes = codec.getOutputBuffer(index)?.let { buffer ->
                        buffer.position(info.offset)
                        buffer.limit(info.offset + info.size)
                        ByteArray(info.size).also { buffer.get(it) }
                    }
                    if (bytes != null) emit(bytes, info.flags, info.presentationTimeUs)?.let { sink?.onFrame(it) }
                }
            } finally {
                runCatching { codec.releaseOutputBuffer(index, false) }
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) lock.withLock { ended }?.countDown()
            }
        }

        override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
            val sink = lock.withLock { output.takeIf { this@MediaCodecStreamEncoder.codec === owner } }
            sink?.onError(error.errorCode, error.message ?: "codec error")
        }

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            val sets = ParameterSets.extract(format, lock.withLock { activeCodec })
            if (sets.isNotEmpty()) lock.withLock { parameterSets = sets }
        }
    }

    /**
     * One output buffer as a coded picture: the parameter sets kept aside (from a codec-config buffer,
     * or inlined ahead of an IDR) and repeated on every keyframe. Null for a buffer with no picture.
     */
    internal fun emit(bytes: ByteArray, flags: Int, presentationTimeUs: Long): EncodedVideoFrame? {
        val units = NALUnitConversion.elementaryUnitsFromAnnexB(bytes)
        if (units.isEmpty()) return null
        val active = lock.withLock { activeCodec }
        if (flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
            lock.withLock { parameterSets = units }
            return null
        }
        val inline = units.filter { VideoEncoder.isParameterSet(it, active) }
        if (inline.isNotEmpty()) lock.withLock { parameterSets = inline }
        val pictures = units.filterNot { VideoEncoder.isParameterSet(it, active) }
        if (pictures.isEmpty()) return null
        val keyframe = flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        return EncodedVideoFrame(
            nalUnits = pictures,
            parameterSets = if (keyframe) lock.withLock { parameterSets } else emptyList(),
            isKeyframe = keyframe,
            presentationTime = presentationTimeUs / 1_000_000.0
        )
    }

    companion object {
        /** How long without a new picture before the encoder codes the last one again. */
        const val repeatPreviousFrameMicros = 100_000L

        /**
         * The session's format: CBR at [StreamEncoderConfig.bitrate], the GOP, no B-frames, real time.
         * A live session also repeats its last picture and holds to its frame rate; a recording's
         * does neither.
         */
        fun format(config: StreamEncoderConfig, surfaceInput: Boolean = true): MediaFormat =
            MediaFormat.createVideoFormat(config.codec.mimeType, config.width, config.height).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    if (surfaceInput) {
                        MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
                    } else {
                        MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
                    }
                )
                setInteger(MediaFormat.KEY_BIT_RATE, config.bitrate)
                setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
                setInteger(MediaFormat.KEY_FRAME_RATE, config.frameRate)
                setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, config.gopSeconds.toFloat())
                if (config.live) {
                    setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, config.frameRate.toFloat())
                    setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, repeatPreviousFrameMicros)
                }
                setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                setInteger(MediaFormat.KEY_LATENCY, 1)
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                setInteger(
                    MediaFormat.KEY_PROFILE,
                    when (config.codec) {
                        StreamCodec.HEVC -> MediaCodecInfo.CodecProfileLevel.HEVCProfileMain
                        StreamCodec.H264 -> MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
                    }
                )
            }
    }
}
