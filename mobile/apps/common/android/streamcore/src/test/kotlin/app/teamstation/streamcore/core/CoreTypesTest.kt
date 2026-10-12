package app.teamstation.streamcore.core

import app.teamstation.streamcore.bitrate.CongestionSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The value types that moved into the library alongside the code that reads them. */
class CoreTypesTest {
    @Test
    fun `a lens names itself by focal length, else by zoom, with its side`() {
        val wide = CameraLens("0", CameraPosition.BACK, "2", 24, 1.0, 1.0)
        assertEquals("24 mm", wide.title)
        assertEquals("Back · 1x", wide.subtitle)
        assertEquals("24 mm · Back", wide.settingsLabel)
        assertEquals("settings-lens-back-1x", wide.testTag)

        val front = CameraLens("1", CameraPosition.FRONT, "1", null, 1.0, 1.0)
        assertEquals("1x", front.title)
        assertEquals("Front · 1x", front.subtitle)
        assertEquals("1x · Front", front.settingsLabel)
    }

    @Test
    fun `a capture format reports its size, label and frame-rate range`() {
        val format = CaptureFormatDescriptor(1920, 1080, 15.0, 60.0, supportsMultiLensSwitching = true)
        assertEquals(1920 * 1080, format.pixelCount)
        assertEquals("1920x1080@60", format.label)
        assertTrue(format.supports(30.0))
        assertTrue(format.supports(60.005))
        assertFalse(format.supports(120.0))
        assertFalse(format.supports(10.0))
        assertFalse(format.isBinned)
    }

    @Test
    fun `the worst link is the one dropping, then the one waiting longest`() {
        val calm = CongestionSample(interval = 1.0, queueDelay = 0.1)
        val waiting = CongestionSample(interval = 1.0, queueDelay = 0.8)
        val dropping = CongestionSample(interval = 1.0, queueDelay = 0.2, droppedFrames = 3)
        val flushing = CongestionSample(interval = 1.0, flushes = 1)

        assertEquals(waiting, CongestionSample.worst(listOf(calm, waiting)))
        assertEquals(dropping, CongestionSample.worst(listOf(waiting, dropping, calm)))
        assertEquals(flushing, CongestionSample.worst(listOf(calm, flushing)))
        assertNull(CongestionSample.worst(emptyList()))
    }
}
