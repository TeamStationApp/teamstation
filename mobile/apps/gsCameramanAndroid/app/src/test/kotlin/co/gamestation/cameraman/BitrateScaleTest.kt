package co.gamestation.cameraman

import co.gamestation.cameraman.core.CameraParameters
import co.gamestation.cameraman.core.StreamSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The bitrate runs from 1 to 16 Mbps: in the Settings sliders, over the wire, and in what is saved. */
class BitrateScaleTest {
    @Test
    fun `the scale tops out at sixteen megabits`() {
        assertEquals(16_000_000, StreamSettings.maximumBitrate)
        assertEquals(16_000, CameraParameters.maximumBitrateKbps)
    }

    @Test
    fun `a rate above the scale comes down to its top`() {
        assertEquals(16_000_000, StreamSettings(bitrate = 30_000_000).bitrate)
        val settings = StreamSettings(bitrate = 8_000_000)
        settings.selectBitrate(20_000_000)
        assertEquals(16_000_000, settings.bitrate)
        assertTrue(settings.bitrateFloor <= settings.bitrate)
    }

    @Test
    fun `a copy that asks for more than the scale gets its top`() {
        assertEquals(16_000_000, StreamSettings.default.copy(bitrate = 45_000_000).bitrate)
    }
}
