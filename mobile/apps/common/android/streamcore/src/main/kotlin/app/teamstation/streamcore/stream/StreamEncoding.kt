package app.teamstation.streamcore.stream

import android.view.Surface
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec

/** What a stream encoder session is opened with. */
data class StreamEncoderConfig(
    val codec: StreamCodec,
    val width: Int,
    val height: Int,
    val frameRate: Int,
    val bitrate: Int,
    val gopSeconds: Double
)

/**
 * The stream's video encoder: MediaCodec ([MediaCodecStreamEncoder]) on a device, a fake in tests.
 * Pictures arrive through the session's input surface, so the interface is about the output side.
 */
interface StreamVideoEncoding {
    interface Output {
        /** A coded picture: elementary NAL units, with the parameter sets on a keyframe. */
        fun onFrame(frame: EncodedVideoFrame)

        /** The encoder reported a failure. */
        fun onError(code: Int, message: String)
    }

    /** Opens a session. Answers the surface pictures are drawn into, null where there is none. */
    fun open(config: StreamEncoderConfig, output: Output): Surface?

    /** The next picture is an IDR: `REQUEST_SYNC_FRAME`. */
    fun requestSyncFrame()

    /** The rate for the next pictures, on the running session. */
    fun setBitrate(bitrate: Int)

    fun close()
}

/**
 * The stream's AAC encoder, synchronous like TS Director's `AACPacketizer`: PCM in, whatever packets
 * the encoder has finished out.
 */
interface StreamAudioEncoding {
    /** The two-byte AudioSpecificConfig the FLV sequence header carries. */
    val audioSpecificConfig: ByteArray

    /** The encoder's priming: packet N decodes to the input from this many samples before N × 1024. */
    val primingSamples: Int

    /** Encodes interleaved stereo 48 kHz PCM, answering every packet that came out. */
    fun encode(samples: ShortArray): List<ByteArray>

    /** Starts again: the next packet is packet zero. */
    fun reset()

    fun close()
}
