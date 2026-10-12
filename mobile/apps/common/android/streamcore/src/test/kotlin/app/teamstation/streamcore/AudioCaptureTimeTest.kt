package app.teamstation.streamcore

import app.teamstation.streamcore.capture.MicrophoneSource
import app.teamstation.streamcore.core.EncodedAudioFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AudioCaptureTimeTest {

    @Test
    fun `a sample the timestamp names is captured at the timestamp's time`() {
        val seconds = MicrophoneSource.captureSeconds(
            nanoTime = 5_000_000_000L, framePosition = 48_000, framesRead = 48_000, sampleRate = 48_000
        )
        assertEquals(5.0, seconds, 1e-9)
    }

    @Test
    fun `samples read before the timestamp's position were captured earlier`() {
        // The timestamp is 2,400 samples ahead of what this read has reached: 50 ms at 48 kHz.
        val seconds = MicrophoneSource.captureSeconds(
            nanoTime = 5_000_000_000L, framePosition = 50_400, framesRead = 48_000, sampleRate = 48_000
        )
        assertEquals(4.95, seconds, 1e-9)
    }

    @Test
    fun `capture time is part of a frame's identity`() {
        val data = byteArrayOf(1, 2, 3)
        val a = EncodedAudioFrame(data, 1.0, 48_000, 1, captureTime = 10.0)
        val b = EncodedAudioFrame(data, 1.0, 48_000, 1, captureTime = 10.02)
        assertNotEquals(a, b)
        assertEquals(a, EncodedAudioFrame(data, 1.0, 48_000, 1, captureTime = 10.0))
    }
}
