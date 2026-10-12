package app.teamstation.streamcore.stream

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Looper
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowMediaCodec
import java.util.Collections

/** The MediaCodec sessions behind [ProgramStreamer], on Robolectric's codec, which copies input to output. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MediaCodecEncodersTest {
    private val copy = ShadowMediaCodec.CodecConfig(64 * 1024, 64 * 1024) { input, output -> output.put(input) }

    @After
    fun tearDown() {
        ShadowMediaCodec.clearCodecs()
    }

    @Test
    fun theStreamFormatIsConstantRateWithTheGopAndNoBFrames() {
        val format = MediaCodecStreamEncoder.format(StreamEncoderConfig(StreamCodec.HEVC, 1920, 1080, 30, 4_000_000, 2.0))
        assertEquals("video/hevc", format.getString(MediaFormat.KEY_MIME))
        assertEquals(4_000_000, format.getInteger(MediaFormat.KEY_BIT_RATE))
        assertEquals(2.0f, format.getFloat(MediaFormat.KEY_I_FRAME_INTERVAL))
        assertEquals(0, format.getInteger(MediaFormat.KEY_MAX_B_FRAMES))
        assertEquals(30.0f, format.getFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER))
        assertEquals(MediaCodecStreamEncoder.repeatPreviousFrameMicros, format.getLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER))
        val avc = MediaCodecStreamEncoder.format(StreamEncoderConfig(StreamCodec.H264, 1280, 720, 30, 2_000_000, 1.0), surfaceInput = false)
        assertEquals("video/avc", avc.getString(MediaFormat.KEY_MIME))
    }

    @Test
    fun aSessionEmitsPicturesWithTheirParameterSets() {
        ShadowMediaCodec.addEncoder("video/hevc", copy)
        val encoder = MediaCodecStreamEncoder(surfaceInput = false)
        val frames = Collections.synchronizedList(mutableListOf<EncodedVideoFrame>())
        val errors = mutableListOf<Int>()
        val output = object : StreamVideoEncoding.Output {
            override fun onFrame(frame: EncodedVideoFrame) {
                frames += frame
            }

            override fun onError(code: Int, message: String) {
                errors += code
            }
        }
        val surface = encoder.open(StreamEncoderConfig(StreamCodec.HEVC, 1920, 1080, 30, 4_000_000, 2.0), output)
        assertNull(surface)
        encoder.requestSyncFrame()
        encoder.setBitrate(2_000_000)
        shadowOf(Looper.getMainLooper()).idle()
        val start = byteArrayOf(0, 0, 0, 1)
        val sets = start + byteArrayOf(0x40, 1, 9) + start + byteArrayOf(0x42, 1, 9) + start + byteArrayOf(0x44, 1, 9)
        encoder.queueForTesting(sets, 0, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
        encoder.queueForTesting(start + byteArrayOf(0x26, 1, 7), 33_333, MediaCodec.BUFFER_FLAG_KEY_FRAME)
        encoder.queueForTesting(start + byteArrayOf(0x02, 1, 8), 66_666)
        val deadline = System.nanoTime() + 5_000_000_000L
        while (frames.size < 2 && System.nanoTime() < deadline) Thread.sleep(10)
        assertEquals(2, frames.size)
        assertEquals(3, frames[0].parameterSets.size)
        assertTrue(frames[0].isKeyframe)
        assertEquals(0.033333, frames[0].presentationTime, 1e-6)
        assertArrayEquals(byteArrayOf(0x02, 1, 8), frames[1].nalUnits.single())
        assertTrue(frames[1].parameterSets.isEmpty())
        encoder.close()
        encoder.close()
        encoder.requestSyncFrame()
        encoder.setBitrate(1)
        encoder.queueForTesting(byteArrayOf(1), 0)
        assertTrue(errors.isEmpty())
    }

    @Test
    fun picturesAreSplitFromInlineParameterSets() {
        val encoder = MediaCodecStreamEncoder(surfaceInput = false)
        val start = byteArrayOf(0, 0, 0, 1)
        assertNull(encoder.emit(byteArrayOf(1, 2, 3), 0, 0))
        assertNull(encoder.emit(start + byteArrayOf(0x40, 1), 0, 0))
        val frame = encoder.emit(start + byteArrayOf(0x42, 1) + start + byteArrayOf(0x26, 1, 5), MediaCodec.BUFFER_FLAG_KEY_FRAME, 2_000_000)!!
        assertEquals(listOf(listOf<Byte>(0x42, 1)), frame.parameterSets.map { it.toList() })
        assertEquals(2.0, frame.presentationTime, 0.0)
    }

    @Test
    fun theAacSessionTakesWholeFramesAndKeepsTheRest() {
        ShadowMediaCodec.addEncoder(MediaFormat.MIMETYPE_AUDIO_AAC, copy)
        val encoder = MediaCodecAacEncoder()
        assertArrayEquals(byteArrayOf(0x11, 0x90.toByte()), encoder.audioSpecificConfig)
        assertEquals(2048, encoder.primingSamples)
        // Two and a half frames of stereo: two packets now, the half kept for the next call.
        val packets = encoder.encode(ShortArray(1024 * 5) { 1 })
        val later = encoder.encode(ShortArray(1024) { 2 })
        assertEquals(3, packets.size + later.size)
        assertTrue(packets.all { it.size == 4096 })
        encoder.reset()
        assertTrue(encoder.encode(ShortArray(100)).isEmpty())
        encoder.close()
        encoder.close()
    }
}
