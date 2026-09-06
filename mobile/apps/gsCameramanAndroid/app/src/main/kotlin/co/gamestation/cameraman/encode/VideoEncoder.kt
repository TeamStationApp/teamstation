package co.gamestation.cameraman.encode

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import co.gamestation.cameraman.core.EncodedVideoFrame
import co.gamestation.cameraman.core.StreamCodec
import co.gamestation.cameraman.core.StreamSettings
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.roundToInt

/**
 * Hardware H.264 / HEVC encoding.
 *
 * Confined to one handler thread like the capture session, and it emits [EncodedVideoFrame] — plain
 * elementary NAL units — so the packetizers never see a codec buffer and can be tested on bytes.
 *
 * Frames arrive through an input `Surface` rather than through byte buffers. That is the whole
 * reason this app can hold 1080p30 without heating the phone: the camera writes into the encoder's
 * own buffers and no frame is ever copied through the CPU. The cost is that [encode] has no
 * per-frame entry point the way the iOS build does — the surface *is* the entry point — so
 * everything here is about the output side.
 */
class VideoEncoder {
    sealed interface Failure {
        val description: String

        data class SessionCreation(val reason: String) : Failure {
            override val description: String get() = "could not create a compression session ($reason)"
        }

        data class Encode(val reason: String) : Failure {
            override val description: String get() = "encode failed ($reason)"
        }
    }

    private val thread = HandlerThread("cameraman-encode").apply { start() }
    private val handler = Handler(thread.looper)
    private val lock = ReentrantLock()

    private var codec: MediaCodec? = null

    /** Elementary-stream frames, delivered on the encoder thread. */
    var onFrame: ((EncodedVideoFrame) -> Unit)? = null
    var onFailure: ((Failure) -> Unit)? = null

    private var activeCodec: StreamCodec = StreamCodec.H264
    private var parameterSets: List<ByteArray> = emptyList()
    private var inputSurface: Surface? = null

    /**
     * The surface the camera — or the GL pipeline standing in for it — draws into. Null until
     * [configure] has run, and a *different object* after every reconfigure, so a caller that
     * cached one across a codec change would be feeding a released encoder.
     */
    fun currentInputSurface(): Surface? = lock.withLock { inputSurface }

    fun configure(settings: StreamSettings, onReady: (Surface?) -> Unit) {
        handler.post {
            teardownLocked()
            try {
                val surface = createSession(settings)
                onReady(surface)
            } catch (error: Exception) {
                onFailure?.invoke(
                    Failure.SessionCreation(error.message ?: error.javaClass.simpleName)
                )
                onReady(null)
            }
        }
    }

    /**
     * Forces the next frame to be a keyframe. A client that joins between keyframes otherwise waits
     * out the whole interval showing nothing.
     *
     * `PARAMETER_KEY_REQUEST_SYNC_FRAME` is a request to the running codec rather than a per-frame
     * option, which is the one place this differs from VideoToolbox's
     * `kVTEncodeFrameOptionKey_ForceKeyFrame`: there is no frame to attach it to, because frames
     * arrive on a surface. The effect a client sees is the same — the next picture is an IDR.
     */
    fun requestKeyframe() {
        handler.post {
            val running = lock.withLock { codec } ?: return@post
            runCatching {
                running.setParameters(
                    Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }
                )
            }
        }
    }

    fun setBitrate(bitrate: Int) {
        handler.post {
            val running = lock.withLock { codec } ?: return@post
            runCatching {
                running.setParameters(
                    Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bitrate) }
                )
            }
        }
    }

    fun invalidate() {
        handler.post { teardownLocked() }
    }

    /** The current decoder configuration, for the SDP. Empty until the first keyframe is encoded. */
    fun currentParameterSets(): List<ByteArray> = lock.withLock { parameterSets }

    // MARK: - Session

    private fun createSession(settings: StreamSettings): Surface {
        val format = MediaFormat.createVideoFormat(
            settings.codec.mimeType,
            settings.width,
            settings.height
        ).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, settings.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, settings.frameRate.roundToInt())
            // One keyframe a second. A client joining a stream waits at most that long for a
            // picture, and it bounds how much a lost keyframe costs.
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            // Constant rate, because the receiving end budgets a link rather than a file size, and a
            // VBR burst on a busy scene arrives exactly when a phone's uplink can least carry it.
            setInteger(
                MediaFormat.KEY_BITRATE_MODE,
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
            )
            // Live streaming, not file export: never trade latency for compression. `KEY_LATENCY` of
            // one frame is the closest thing to `kVTCompressionPropertyKey_RealTime`, and
            // `KEY_PRIORITY` 0 asks for a realtime slot rather than a best-effort one.
            setInteger(MediaFormat.KEY_LATENCY, 1)
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            // B-frames would reorder output, which forces either a reordering buffer or wrong RTP
            // timestamps. Neither is worth the few percent of bitrate. Android's default is already
            // zero, but an encoder that respects the hint should be told rather than trusted.
            setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            setInteger(MediaFormat.KEY_PROFILE, profile(settings.codec))
            setInteger(MediaFormat.KEY_LEVEL, level(settings.codec))
        }

        val created = MediaCodec.createEncoderByType(settings.codec.mimeType)
        created.setCallback(callback, handler)
        created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = created.createInputSurface()
        created.start()

        lock.withLock {
            codec = created
            activeCodec = settings.codec
            parameterSets = emptyList()
            inputSurface = surface
        }
        return surface
    }

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
            // Never called in surface mode; the camera fills the buffers.
        }

        override fun onOutputBufferAvailable(
            codec: MediaCodec,
            index: Int,
            info: MediaCodec.BufferInfo
        ) {
            val running = lock.withLock { this@VideoEncoder.codec }
            if (running !== codec) {
                // A buffer from a session that has already been torn down. Releasing it against the
                // old codec would throw; dropping it is correct because nothing downstream wants it.
                runCatching { codec.releaseOutputBuffer(index, false) }
                return
            }
            try {
                emit(codec, index, info)
            } catch (error: Exception) {
                onFailure?.invoke(Failure.Encode(error.message ?: error.javaClass.simpleName))
            } finally {
                runCatching { codec.releaseOutputBuffer(index, false) }
            }
        }

        override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
            onFailure?.invoke(Failure.Encode("${error.errorCode}: ${error.message}"))
        }

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            // `csd-0` / `csd-1` arrive here before the first picture on most encoders, which is what
            // lets a client that DESCRIBEs early get a usable SDP without waiting for a keyframe.
            val sets = ParameterSets.extract(format, lock.withLock { activeCodec })
            if (sets.isNotEmpty()) lock.withLock { parameterSets = sets }
        }
    }

    private fun emit(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        if (info.size <= 0) return
        val buffer = codec.getOutputBuffer(index) ?: return
        buffer.position(info.offset)
        buffer.limit(info.offset + info.size)
        val bytes = ByteArray(info.size)
        buffer.get(bytes)

        val units = NALUnitConversion.elementaryUnitsFromAnnexB(bytes)
        if (units.isEmpty()) return

        val activeCodec = lock.withLock { this.activeCodec }

        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
            // The codec-config buffer is the parameter sets and nothing else. It is not a picture,
            // so it is recorded and not emitted; sending it as a frame would put an access unit with
            // no slice on the wire.
            lock.withLock { parameterSets = units }
            return
        }

        val isKeyframe = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        // Some encoders inline the parameter sets ahead of every IDR whether or not
        // KEY_PREPEND_HEADER_TO_SYNC_FRAMES was asked for. Carrying them only in `parameterSets`
        // keeps the wire identical across handsets and identical to the iOS build, instead of
        // sending SPS and PPS twice on some devices and once on others.
        val inlineSets = units.filter { isParameterSet(it, activeCodec) }
        if (inlineSets.isNotEmpty()) lock.withLock { parameterSets = inlineSets }
        val pictureUnits = units.filterNot { isParameterSet(it, activeCodec) }
        if (pictureUnits.isEmpty()) return

        onFrame?.invoke(
            EncodedVideoFrame(
                nalUnits = pictureUnits,
                // Repeated on every keyframe, so a client that joined mid-stream recovers without a
                // new DESCRIBE.
                parameterSets = if (isKeyframe) lock.withLock { parameterSets } else emptyList(),
                isKeyframe = isKeyframe,
                presentationTime = info.presentationTimeUs / 1_000_000.0
            )
        )
    }

    private fun teardownLocked() {
        val running = lock.withLock {
            val current = codec
            codec = null
            inputSurface = null
            parameterSets = emptyList()
            current
        }
        if (running == null) return
        runCatching { running.stop() }
        runCatching { running.release() }
    }

    companion object {
        /** SPS, PPS and — for HEVC — VPS, by NAL type. */
        fun isParameterSet(nal: ByteArray, codec: StreamCodec): Boolean {
            if (nal.isEmpty()) return false
            return when (codec) {
                StreamCodec.H264 -> (nal[0].toInt() and 0x1F) in intArrayOf(7, 8)
                StreamCodec.HEVC -> {
                    if (nal.size < 2) return false
                    ((nal[0].toInt() and 0xFF) shr 1 and 0x3F) in intArrayOf(32, 33, 34)
                }
            }
        }

        /**
         * High profile is what every RTSP client in this project already decodes, and it is worth
         * several percent of bitrate over baseline.
         */
        private fun profile(codec: StreamCodec): Int = when (codec) {
            StreamCodec.H264 -> MediaCodecInfo.CodecProfileLevel.AVCProfileHigh
            StreamCodec.HEVC -> MediaCodecInfo.CodecProfileLevel.HEVCProfileMain
        }

        /**
         * Level 4.2 for AVC and 4.1 for HEVC: both cover 1080p60 with room for the bitrate ceiling,
         * and neither is high enough to let a client decide it cannot decode a stream it can.
         *
         * VideoToolbox has `_AutoLevel` and MediaCodec does not — an unset level makes some encoders
         * advertise 5.1 in the SPS regardless of what they emit, and `profile-level-id` is what a
         * client checks before it even tries.
         */
        private fun level(codec: StreamCodec): Int = when (codec) {
            StreamCodec.H264 -> MediaCodecInfo.CodecProfileLevel.AVCLevel42
            StreamCodec.HEVC -> MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel41
        }
    }
}
