package co.gamestation.cameraman

import co.gamestation.cameraman.core.ZoomMapping
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * The arithmetic is shared with the iOS build, so the fixtures are too: an iPhone 13 Pro's measured
 * numbers exercise the `displayMultiplier != 1` path that Android never takes, and the Pixel 10's
 * measured numbers exercise the path it always takes. A port that only tested its own platform's
 * shape could quietly drop the conversion and still pass.
 */
class ZoomMappingTest {
    /** iPhone 13 Pro triple camera: device 1…18, 0.5 multiplier, handovers at 2 and 6. */
    private val thirteenPro = ZoomMapping(
        minimumDeviceZoom = 1.0,
        maximumDeviceZoom = 18.0,
        displayMultiplier = 0.5,
        switchOverDeviceZooms = listOf(2.0, 6.0)
    )

    /** A single-lens front camera: the two scales coincide. */
    private val front = ZoomMapping(minimumDeviceZoom = 1.0, maximumDeviceZoom = 8.0)

    /**
     * Pixel 10 back camera, measured 2026-09-05: `CONTROL_ZOOM_RATIO_RANGE` starts at 0.556 and the
     * switchovers derived from the constituent focal lengths land at 1.0 and 4.14.
     */
    private val pixelTen = ZoomMapping(
        minimumDeviceZoom = 0.5557733774185181,
        maximumDeviceZoom = 16.543366007620246,
        displayMultiplier = 1.0,
        switchOverDeviceZooms = listOf(0.9999999770996231, 4.135841501905062)
    )

    @Test
    fun `device zoom 1 on an iPhone triple camera reads as half`() {
        assertEquals(0.5, thirteenPro.displayedZoom(1.0), 1e-9)
        // The number an operator calls "1x" is device zoom 2.0, the wide lens.
        assertEquals(2.0, thirteenPro.deviceZoom(1.0), 1e-9)
    }

    @Test
    fun `on Android the two scales coincide`() {
        // CONTROL_ZOOM_RATIO is already what the operator reads, which is the whole reason the
        // multiplier is 1 here and 0.5 on the iPhone.
        assertEquals(1.0, pixelTen.displayMultiplier, 1e-9)
        assertEquals(4.0, pixelTen.displayedZoom(4.0), 1e-9)
        assertEquals(4.0, pixelTen.deviceZoom(4.0), 1e-9)
    }

    @Test
    fun `round-tripping a displayed zoom returns the same value`() {
        for (displayed in listOf(0.5, 1.0, 2.0, 3.0, 7.5)) {
            val device = thirteenPro.deviceZoom(displayed)
            assertTrue(abs(thirteenPro.displayedZoom(device) - displayed) < 1e-4)
        }
    }

    @Test
    fun `clamping holds the device range`() {
        assertEquals(1.0, thirteenPro.clampDeviceZoom(0.1), 1e-9)
        assertEquals(18.0, thirteenPro.clampDeviceZoom(99.0), 1e-9)
        assertEquals(4.0, thirteenPro.clampDeviceZoom(4.0), 1e-9)
        // 0.25x does not exist on this hardware and must come back as the widest, 0.5x.
        assertEquals(0.5, thirteenPro.clampDisplayedZoom(0.25), 1e-9)
        assertEquals(9.0, thirteenPro.clampDisplayedZoom(100.0), 1e-9)
    }

    @Test
    fun `a non-finite zoom falls back to the widest rather than the ceiling`() {
        // A NaN or an infinity is a bug upstream, not a request to zoom all the way in. Coming back
        // at the widest lens is recoverable; slamming to 16x on a camera watching a field is not.
        assertEquals(1.0, thirteenPro.clampDeviceZoom(Double.NaN), 1e-9)
        assertEquals(1.0, thirteenPro.clampDeviceZoom(Double.POSITIVE_INFINITY), 1e-9)
        assertEquals(1.0, thirteenPro.clampDeviceZoom(Double.NEGATIVE_INFINITY), 1e-9)
    }

    @Test
    fun `lens index steps at each switchover`() {
        assertEquals(0, thirteenPro.lensIndex(1.0))
        assertEquals(0, thirteenPro.lensIndex(1.99))
        assertEquals(1, thirteenPro.lensIndex(2.0))
        assertEquals(1, thirteenPro.lensIndex(5.99))
        assertEquals(2, thirteenPro.lensIndex(6.0))
        // One lens means one index, whatever the digital zoom.
        assertEquals(0, front.lensIndex(8.0))
    }

    @Test
    fun `preset pills come out of the hardware, not a hardcoded row`() {
        assertEquals(listOf(0.5, 1.0, 3.0, 9.0), thirteenPro.presetDisplayedZooms)
        // One lens plus the digital ceiling — not a second optical preset.
        assertEquals(listOf(1.0, 8.0), front.presetDisplayedZooms)
        // The Pixel's row reads 0.6x / 1x / 4.1x / 16.5x, which is what the handset actually offers.
        assertEquals(
            listOf("0.6x", "1x", "4.1x", "16.5x"),
            pixelTen.presetDisplayedZooms.map { ZoomMapping.label(it) }
        )
    }

    @Test
    fun `pinch multiplies against the zoom at gesture start`() {
        assertEquals(4.0, thirteenPro.pinchedDeviceZoom(2.0, 2.0), 1e-9)
        assertEquals(1.0, thirteenPro.pinchedDeviceZoom(2.0, 0.25), 1e-9)
        // A pinch that would exceed the hardware stops at the limit rather than throwing.
        assertEquals(18.0, thirteenPro.pinchedDeviceZoom(10.0, 4.0), 1e-9)
    }

    @Test
    fun `a zero or invalid pinch scale leaves the zoom where it started`() {
        assertEquals(3.0, thirteenPro.pinchedDeviceZoom(3.0, 0.0), 1e-9)
        assertEquals(3.0, thirteenPro.pinchedDeviceZoom(3.0, Double.NaN), 1e-9)
    }

    @Test
    fun `unreachable switchovers are discarded`() {
        val mapping = ZoomMapping(
            minimumDeviceZoom = 1.0,
            maximumDeviceZoom = 5.0,
            displayMultiplier = 0.5,
            switchOverDeviceZooms = listOf(0.5, 1.0, 2.0, 9.0)
        )
        // 0.5 and 1 are at or below the minimum and 9 is past the maximum: a pill for any of them
        // would do nothing when tapped.
        assertEquals(listOf(2.0), mapping.switchOverDeviceZooms)
    }

    @Test
    fun `switchovers are sorted, so lens index cannot depend on device ordering`() {
        val mapping = ZoomMapping(
            minimumDeviceZoom = 1.0,
            maximumDeviceZoom = 15.0,
            displayMultiplier = 0.5,
            switchOverDeviceZooms = listOf(6.0, 2.0)
        )
        assertEquals(listOf(2.0, 6.0), mapping.switchOverDeviceZooms)
        assertEquals(1, mapping.lensIndex(3.0))
    }

    @Test
    fun `a degenerate multiplier falls back to 1 instead of dividing by zero`() {
        val mapping = ZoomMapping(maximumDeviceZoom = 4.0, displayMultiplier = 0.0)
        assertEquals(1.0, mapping.displayMultiplier, 1e-9)
        assertEquals(2.0, mapping.deviceZoom(2.0), 1e-9)
    }

    @Test
    fun `a maximum below the minimum cannot invert the range`() {
        val mapping = ZoomMapping(minimumDeviceZoom = 2.0, maximumDeviceZoom = 1.0)
        assertEquals(2.0, mapping.maximumDeviceZoom, 1e-9)
        assertEquals(2.0, mapping.clampDeviceZoom(5.0), 1e-9)
    }

    @Test
    fun `a platform recommendation wins over the available maximum`() {
        // The iOS case: every video format on a 13 Pro's triple camera recommends 1…18 while the
        // device reports 189 available, and 189 is digital upscaling.
        assertEquals(18.0, ZoomMapping.resolveMaximumDeviceZoom(18.0, 189.0), 1e-9)
    }

    @Test
    fun `no recommendation falls back rather than exposing the digital ceiling`() {
        // The Android case: there is no recommendation API at all, so every call passes null.
        val ceiling = ZoomMapping.resolveMaximumDeviceZoom(null, 189.0)
        assertEquals(ZoomMapping.singleLensZoomFallback, ceiling, 1e-9)
        assertEquals(5.0, ceiling, 1e-9)
    }

    @Test
    fun `a recommendation above what the device offers cannot exceed the hardware`() {
        assertEquals(12.0, ZoomMapping.resolveMaximumDeviceZoom(30.0, 12.0), 1e-9)
    }

    @Test
    fun `a degenerate recommendation of 1 is treated as absent`() {
        assertEquals(5.0, ZoomMapping.resolveMaximumDeviceZoom(1.0, 189.0), 1e-9)
    }

    @Test
    fun `labels read the way a camera app writes them`() {
        assertEquals("0.5x", ZoomMapping.label(0.5))
        assertEquals("1x", ZoomMapping.label(1.0))
        assertEquals("3x", ZoomMapping.label(3.0))
        assertEquals("2.5x", ZoomMapping.label(2.5))
        assertEquals("16.5x", ZoomMapping.label(16.543366007620246))
    }

    @Test
    fun `an exact lens zoom lights the preset, not a neighbouring tick`() {
        assertEquals(ZoomMapping.ScaleHighlight.Preset(0.5), thirteenPro.scaleHighlight(0.5))
        assertEquals(ZoomMapping.ScaleHighlight.Preset(1.0), thirteenPro.scaleHighlight(1.0))
        assertEquals(ZoomMapping.ScaleHighlight.Preset(3.0), thirteenPro.scaleHighlight(3.0))
        assertEquals(ZoomMapping.ScaleHighlight.Preset(9.0), thirteenPro.scaleHighlight(9.0))
        // The label rounds to one decimal, so 1.04 still reads 1x and keeps the 1x button lit.
        assertEquals(ZoomMapping.ScaleHighlight.Preset(1.0), thirteenPro.scaleHighlight(1.04))
    }

    @Test
    fun `a pinch between two lenses lights one of the five bars`() {
        assertEquals(3, thirteenPro.scaleSegmentCount)
        assertEquals(ZoomMapping.ScaleHighlight.Tick(0, 2), thirteenPro.scaleHighlight(0.7))
        assertEquals(ZoomMapping.ScaleHighlight.Tick(1, 2), thirteenPro.scaleHighlight(2.0))
        // First bar of a segment, not the left-hand preset.
        assertEquals(ZoomMapping.ScaleHighlight.Tick(0, 1), thirteenPro.scaleHighlight(0.6))
        // 3x…9x is a real segment, not "past the last lens".
        assertEquals(ZoomMapping.ScaleHighlight.Tick(2, 2), thirteenPro.scaleHighlight(6.0))
    }

    @Test
    fun `a single-lens camera still gets a digital-max preset`() {
        assertEquals(1, front.scaleSegmentCount)
        assertEquals(ZoomMapping.ScaleHighlight.Preset(1.0), front.scaleHighlight(1.0))
        assertEquals(ZoomMapping.ScaleHighlight.Preset(8.0), front.scaleHighlight(8.0))
        assertEquals(ZoomMapping.ScaleHighlight.Tick(0, 1), front.scaleHighlight(3.0))
    }

    @Test
    fun `scale progress is equal per pill gap, not per zoom ratio`() {
        assertEquals(0.0, thirteenPro.scaleProgress(0.5), 1e-4)
        assertEquals(1.0 / 3, thirteenPro.scaleProgress(1.0), 1e-4)
        assertEquals(2.0 / 3, thirteenPro.scaleProgress(3.0), 1e-4)
        assertEquals(1.0, thirteenPro.scaleProgress(9.0), 1e-4)
        assertEquals(0.5, thirteenPro.displayedZoomForProgress(0.0), 1e-4)
        assertEquals(1.0, thirteenPro.displayedZoomForProgress(1.0 / 3), 1e-4)
        assertEquals(3.0, thirteenPro.displayedZoomForProgress(2.0 / 3), 1e-4)
        assertEquals(9.0, thirteenPro.displayedZoomForProgress(1.0), 1e-4)
    }

    @Test
    fun `a drag as long as one pill gap walks exactly one segment`() {
        val gap = 80.0
        assertEquals(3.0, thirteenPro.displayedZoomByDragging(1.0, gap, gap), 1e-6)
        assertEquals(9.0, thirteenPro.displayedZoomByDragging(3.0, gap, gap), 1e-6)
        assertEquals(0.5, thirteenPro.displayedZoomByDragging(1.0, -gap, gap), 1e-6)
        assertEquals(2.0, thirteenPro.displayedZoomByDragging(1.0, gap / 2, gap), 1e-6)
        // Past the end of the scale stops at the ceiling rather than running away.
        assertEquals(9.0, thirteenPro.displayedZoomByDragging(1.0, 4 * gap, gap), 1e-6)
    }

    @Test
    fun `a degenerate drag leaves the zoom where it started`() {
        assertEquals(3.0, thirteenPro.displayedZoomByDragging(3.0, 10.0, 0.0), 1e-9)
        assertEquals(3.0, thirteenPro.displayedZoomByDragging(3.0, Double.NaN, 80.0), 1e-9)
    }
}
