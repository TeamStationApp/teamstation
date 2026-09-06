package co.gamestation.cameraman

import co.gamestation.cameraman.core.CameraLens
import co.gamestation.cameraman.core.CameraPosition
import co.gamestation.cameraman.core.InMemorySettingsStore
import co.gamestation.cameraman.core.LensOptics
import co.gamestation.cameraman.core.LensSelection
import co.gamestation.cameraman.core.StreamCodec
import co.gamestation.cameraman.core.StreamSettings
import co.gamestation.cameraman.core.StreamSettingsStore
import co.gamestation.cameraman.rtsp.RTPTimestampSequencer
import co.gamestation.cameraman.rtsp.RTSPServer
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
    }

    @Test
    fun `garbage is ignored rather than crashing`() {
        val store = InMemorySettingsStore(mapOf(StreamSettingsStore.settingsKey to "not a pair"))
        assertNull(StreamSettingsStore(store).load())
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

class RTPTimestampSequencerTest {
    private val sequencer = RTPTimestampSequencer()

    @Test
    fun `an advancing clock passes straight through`() {
        assertEquals(0L, sequencer.next(0))
        assertEquals(3000L, sequencer.next(3000))
        assertEquals(6000L, sequencer.next(6000))
    }

    @Test
    fun `a repeated timestamp is nudged forward`() {
        // Two frames sharing a timestamp are merged by the receiver into one malformed access unit.
        sequencer.next(3000)
        assertEquals(3001L, sequencer.next(3000))
        assertEquals(3002L, sequencer.next(3000))
    }

    @Test
    fun `a step backwards is nudged rather than obeyed`() {
        sequencer.next(6000)
        assertEquals(6001L, sequencer.next(3000))
    }

    @Test
    fun `the 32-bit rollover is a forward step, not a repeat`() {
        // The whole reason this type exists. A plain comparison sees the wrapped value as tiny and
        // nudges every later frame by one tick, which collapses the timeline the receiver records
        // against — and it only shows up 13.3 hours in.
        val justBefore = 0xFFFFFF00L
        assertEquals(justBefore, sequencer.next(justBefore))
        val wrapped = 0x00000100L
        assertEquals(wrapped, sequencer.next(wrapped))
        assertEquals(wrapped + 3000, sequencer.next(wrapped + 3000))
    }

    @Test
    fun `reset forgets the previous frame`() {
        sequencer.next(6000)
        sequencer.reset()
        assertNull(sequencer.lastSent)
        assertEquals(10L, sequencer.next(10))
    }
}

class PreferredAddressTest {

    @Test
    fun `Wi-Fi wins`() {
        assertEquals(
            "10.10.7.157",
            RTSPServer.preferredLANIPv4(
                listOf("rndis0" to "192.168.42.129", "wlan0" to "10.10.7.157")
            )
        )
    }

    @Test
    fun `loopback and link-local never win`() {
        // Handing Director an address it cannot reach is worse than handing it none: it looks like a
        // camera that is up and refusing connections.
        assertNull(
            RTSPServer.preferredLANIPv4(listOf("lo" to "127.0.0.1", "wlan0" to "169.254.10.1"))
        )
    }

    @Test
    fun `a hotspot ranks below the real network`() {
        assertEquals(
            "10.10.7.157",
            RTSPServer.preferredLANIPv4(
                listOf("ap0" to "192.168.43.1", "wlan0" to "10.10.7.157")
            )
        )
    }

    @Test
    fun `something is better than nothing when there is no Wi-Fi`() {
        assertEquals(
            "192.168.42.129",
            RTSPServer.preferredLANIPv4(listOf("rndis0" to "192.168.42.129"))
        )
    }
}
