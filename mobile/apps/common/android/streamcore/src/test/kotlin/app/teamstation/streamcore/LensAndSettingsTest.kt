package app.teamstation.streamcore

import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.streamcore.core.LensOptics
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.core.StreamSettings
import app.teamstation.streamcore.core.StreamSettingsStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LensOpticsTest {

    @Test
    fun `a field of view becomes a 35mm equivalent`() {
        // The conversion Blackmagic's 13 / 24 / 77 mm labels are: f = 18 / tan(fov/2).
        assertEquals(24, LensOptics.equivalentFocalLengthMM(73.7))
        assertEquals(13, LensOptics.equivalentFocalLengthMM(108.9))
        assertEquals(77, LensOptics.equivalentFocalLengthMM(26.4))
    }

    @Test
    fun `an impossible field of view is refused rather than rounded`() {
        assertNull(LensOptics.equivalentFocalLengthMM(0.0))
        assertNull(LensOptics.equivalentFocalLengthMM(180.0))
        assertNull(LensOptics.equivalentFocalLengthMM(Double.NaN))
    }

    @Test
    fun `Camera2's focal length and sensor width give the same field of view`() {
        // iOS publishes the angle; Camera2 publishes the two numbers it comes from. A 6.9 mm lens on
        // a 9.5 mm sensor is a wide-angle, and it has to land in the same place.
        val fov = LensOptics.horizontalFieldOfViewDegrees(focalLengthMM = 6.9, sensorWidthMM = 9.5)
        assertNotNull(fov)
        assertTrue("got $fov", fov!! > 60 && fov < 80)
        assertNull(LensOptics.horizontalFieldOfViewDegrees(0.0, 9.5))
        assertNull(LensOptics.horizontalFieldOfViewDegrees(6.9, 0.0))
    }
}

class LensSelectionTest {
    private val ultraWide = lens("uw", 0.5)
    private val wide = lens("w", 1.0)
    private val tele = lens("t", 5.0)
    private val catalog = listOf(ultraWide, wide, tele)

    private fun lens(id: String, zoom: Double) = CameraLens(
        id = id,
        position = CameraPosition.BACK,
        physicalCameraID = id,
        focalLengthMM = null,
        displayedZoom = zoom,
        deviceZoom = zoom
    )

    @Test
    fun `an empty selection means every lens, including one that appears later`() {
        val selection = LensSelection()
        assertTrue(catalog.all { selection.isEnabled(it) })
        assertTrue(selection.isEnabled(lens("brand-new", 10.0)))
    }

    @Test
    fun `the last lens at a position cannot be turned off`() {
        // Capture would have nothing to open.
        val onlyWide = LensSelection(setOf("uw", "t"))
        assertFalse(onlyWide.canDisable(wide, catalog))
        assertEquals(onlyWide, onlyWide.toggling(wide, false, catalog))
    }

    @Test
    fun `toggling adds and removes ids`() {
        val without = LensSelection().toggling(ultraWide, false, catalog)
        assertEquals(setOf("uw"), without.disabledIDs)
        assertEquals(emptySet<String>(), without.toggling(ultraWide, true, catalog).disabledIDs)
    }

    @Test
    fun `everything on leaves the hardware range alone`() {
        val bounds = LensSelection().zoomBounds(CameraPosition.BACK, catalog)
        assertNotNull(bounds)
        assertNull(bounds!!.minimumDisplayedZoom)
        assertNull(bounds.maximumDisplayedZoom)
    }

    @Test
    fun `disabling the ultra-wide raises the floor to the next lens`() {
        // Android cannot open a different virtual device the way iOS does, so a disabled lens is
        // kept out of shot by clamping the zoom range past it.
        val bounds = LensSelection(setOf("uw")).zoomBounds(CameraPosition.BACK, catalog)!!
        assertEquals(1.0, bounds.minimumDisplayedZoom!!, 1e-9)
        assertNull(bounds.maximumDisplayedZoom)
    }

    @Test
    fun `disabling the telephoto stops the ceiling just below its switchover`() {
        val bounds = LensSelection(setOf("t")).zoomBounds(CameraPosition.BACK, catalog)!!
        assertNull(bounds.minimumDisplayedZoom)
        // Just under, because a logical camera hands over *at* the switchover and a ceiling exactly
        // on it would sometimes land on the lens that was turned off.
        assertTrue(bounds.maximumDisplayedZoom!! < 5.0)
        assertTrue(bounds.maximumDisplayedZoom!! > 4.9)
    }

    @Test
    fun `only the middle lens clamps both ends`() {
        val bounds = LensSelection(setOf("uw", "t")).zoomBounds(CameraPosition.BACK, catalog)!!
        assertEquals(1.0, bounds.minimumDisplayedZoom!!, 1e-9)
        assertTrue(bounds.maximumDisplayedZoom!! < 5.0)
    }

    @Test
    fun `nothing enabled reports no bounds rather than an empty range`() {
        // The caller reads null as "leave the camera alone", not as "open nothing".
        assertNull(LensSelection(setOf("uw", "w", "t")).zoomBounds(CameraPosition.BACK, catalog))
    }

    @Test
    fun `a position with no lenses at all is unconstrained`() {
        val bounds = LensSelection().zoomBounds(CameraPosition.FRONT, catalog)!!
        assertNull(bounds.minimumDisplayedZoom)
        assertNull(bounds.maximumDisplayedZoom)
    }
}

class StreamSettingsPersistenceTest {

    @Test
    fun `nothing saved reads as never configured`() {
        assertNull(StreamSettingsStore(InMemorySettingsStore()).load())
    }

    @Test
    fun `a saved set round-trips`() {
        val store = StreamSettingsStore(InMemorySettingsStore())
        val settings = StreamSettings(
            width = 1280,
            height = 720,
            frameRate = 60.0,
            codec = StreamCodec.H264,
            bitrate = 9_000_000,
            bitrateFloor = 2_500_000,
            adaptiveBitrate = false,
            audioEnabled = false,
            videoEnabled = false,
            disabledLensIDs = setOf("uw", "t"),
            cameraPosition = CameraPosition.FRONT,
            displayedZoom = 2.5
        )
        store.save(settings)
        assertEquals(settings, store.load())
    }

    @Test
    fun `a stored set missing a field keeps the default rather than resetting everything`() {
        // The decisive property: a strict decoder would treat an older stored value as corrupt and
        // silently reset every operator setting the first time a field was added.
        val store = InMemorySettingsStore(
            mapOf(StreamSettingsStore.settingsKey to "width=1280&height=720")
        )
        val loaded = StreamSettingsStore(store).load()
        assertNotNull(loaded)
        assertEquals(1280, loaded!!.width)
        assertEquals(StreamSettings().codec, loaded.codec)
        assertEquals(StreamSettings().audioEnabled, loaded.audioEnabled)
        // Saved before adaptation existed, which comes back on like a new install.
        assertTrue(loaded.adaptiveBitrate)
        // Saved before the floor was a setting, when it was always half the rate.
        assertEquals(2_000_000, loaded.bitrateFloor)
    }

    @Test
    fun `a saved rate without a floor comes back at half, and a floor above the rate is brought down`() {
        val older = InMemorySettingsStore(mapOf(StreamSettingsStore.settingsKey to "codec=h264&bitrate=6000000"))
        assertEquals(3_000_000, StreamSettingsStore(older).load()!!.bitrateFloor)
        val inverted = InMemorySettingsStore(mapOf(StreamSettingsStore.settingsKey to "bitrate=4000000&bitrateFloor=9000000"))
        assertEquals(4_000_000, StreamSettingsStore(inverted).load()!!.bitrateFloor)
    }

    @Test
    fun `a codec change moves a default floor with the default rate, and leaves a chosen one alone`() {
        val settings = StreamSettings()
        assertEquals(2_000_000, settings.bitrateFloor)
        settings.selectCodec(StreamCodec.H264)
        assertEquals(3_000_000, settings.bitrateFloor)
        settings.bitrateFloor = 1_500_000
        settings.selectCodec(StreamCodec.HEVC)
        assertEquals(4_000_000, settings.bitrate)
        assertEquals(1_500_000, settings.bitrateFloor)
    }

    @Test
    fun `a new rate carries a default floor at half, keeps a chosen one, and never leaves it above`() {
        val settings = StreamSettings()
        settings.selectBitrate(10_000_000)
        assertEquals(5_000_000, settings.bitrateFloor)
        settings.bitrateFloor = 3_000_000
        settings.selectBitrate(12_000_000)
        assertEquals(3_000_000, settings.bitrateFloor)
        settings.selectBitrate(2_000_000)
        assertEquals(2_000_000, settings.bitrateFloor)

        // The default is not below 1 Mbps, and a copy that lowers the rate takes the floor with it.
        assertEquals(1_000_000, StreamSettings(bitrate = 1_500_000).bitrateFloor)
        assertEquals(4_000_000, StreamSettings(bitrate = 4_000_000, bitrateFloor = 6_000_000).bitrateFloor)
        assertEquals(1_000_000, StreamSettings(bitrate = 8_000_000, bitrateFloor = 3_000_000).copy(bitrate = 1_000_000).bitrateFloor)
    }

    @Test
    fun `a pinned rate brings its own floor, otherwise the saved floor comes back under the rate`() {
        val saved = StreamSettings().apply {
            selectBitrate(10_000_000)
            bitrateFloor = 7_000_000
        }
        val pinnedRate = StreamSettings().apply { selectBitrate(6_000_000) }
        val merged = pinnedRate.merging(saved, explicit = setOf(StreamSettings.Field.BITRATE_MBPS))
        assertEquals(6_000_000, merged.bitrate)
        assertEquals(3_000_000, merged.bitrateFloor)

        assertEquals(7_000_000, StreamSettings().merging(saved, explicit = emptySet()).bitrateFloor)

        val pinnedFloor = StreamSettings(bitrateFloor = 1_500_000)
        val floorKept = pinnedFloor.merging(saved, explicit = setOf(StreamSettings.Field.BITRATE_FLOOR_MBPS))
        assertEquals(10_000_000, floorKept.bitrate)
        assertEquals(1_500_000, floorKept.bitrateFloor)
    }

    @Test
    fun `garbage is ignored rather than crashing`() {
        val store = InMemorySettingsStore(mapOf(StreamSettingsStore.settingsKey to "not a pair"))
        assertNull(StreamSettingsStore(store).load())
    }

    @Test
    fun `a port saved as 554 by an older build loads as the shared 8554`() {
        // Director sweeps one Cameraman port, so a phone still asking for 554 is one it never finds.
        val store = InMemorySettingsStore(
            mapOf(StreamSettingsStore.settingsKey to "codec=h264&port=554")
        )
        val loaded = StreamSettingsStore(store).load()
        assertEquals(8554, loaded!!.port)
        assertEquals(StreamCodec.H264, loaded.codec)
    }

    @Test
    fun `any other saved port is kept`() {
        val store = InMemorySettingsStore(mapOf(StreamSettingsStore.settingsKey to "port=9554"))
        assertEquals(9554, StreamSettingsStore(store).load()!!.port)
    }

    @Test
    fun `an explicit launch argument wins over what was saved`() {
        // Or a flow that pins a format would depend on the state of the handset.
        val saved = StreamSettings(codec = StreamCodec.H264, bitrate = 9_000_000, width = 1280)
        val launched = StreamSettings(codec = StreamCodec.HEVC)
        val merged = launched.merging(saved, explicit = setOf(StreamSettings.Field.CODEC))
        assertEquals(StreamCodec.HEVC, merged.codec)
        // Everything not pinned still comes from the device.
        assertEquals(9_000_000, merged.bitrate)
        assertEquals(1280, merged.width)
    }

    @Test
    fun `blanking is never carried across a launch`() {
        // It is a fault-injection control, not a preference: a camera left blank must come back
        // showing a picture.
        val saved = StreamSettings(videoEnabled = false)
        val merged = StreamSettings().merging(saved, explicit = emptySet())
        assertTrue(merged.videoEnabled)
    }

    @Test
    fun `the operator's framing always comes from the device`() {
        val saved = StreamSettings(cameraPosition = CameraPosition.FRONT, displayedZoom = 3.0)
        val merged = StreamSettings().merging(saved, explicit = StreamSettings.Field.entries.toSet())
        assertEquals(CameraPosition.FRONT, merged.cameraPosition)
        assertEquals(3.0, merged.displayedZoom, 1e-9)
    }

    @Test
    fun `the default codec is HEVC at its own default rate`() {
        assertEquals(StreamCodec.HEVC, StreamSettings().codec)
        assertEquals(StreamCodec.HEVC.defaultBitrate, StreamSettings().bitrate)
    }
}
