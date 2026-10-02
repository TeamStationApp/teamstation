package app.teamstation.cameraman

import app.teamstation.cameraman.core.CaptureFormatDescriptor
import app.teamstation.cameraman.core.DeviceIdentity
import app.teamstation.cameraman.core.DeviceIdentityProvider
import app.teamstation.cameraman.core.IdentityStore
import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.cameraman.core.StreamCodec
import app.teamstation.cameraman.core.StreamSettings
import app.teamstation.cameraman.capture.CameraSession
import app.teamstation.cameraman.capture.FormatCatalogue
import app.teamstation.cameraman.harness.ControlChannel
import app.teamstation.cameraman.radar.RadarPhase
import app.teamstation.cameraman.harness.ControlCommand
import app.teamstation.cameraman.harness.ControlServer
import app.teamstation.cameraman.harness.LaunchConfiguration
import app.teamstation.cameraman.service.CameramanService
import android.view.OrientationEventListener
import android.view.Surface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceIdentityTest {

    @Test
    fun `a new install generates a UUID and keeps it`() {
        val store = InMemoryIdentityStore()
        val provider = DeviceIdentityProvider(store)
        val first = provider.load()
        assertTrue(DeviceIdentityProvider.isWellFormed(first.uuid))
        assertEquals(first.uuid, provider.load().uuid)
    }

    @Test
    fun `the default name is derived from the UUID so two phones cannot collide`() {
        assertEquals(
            "Camera 14E7",
            DeviceIdentity.defaultName("c94df9ca-d7c2-468f-8529-97d01fba14e7")
        )
    }

    @Test
    fun `renaming does not move the identity`() {
        // The whole point: renaming a camera must not make it a new one in TS Director.
        val provider = DeviceIdentityProvider(InMemoryIdentityStore())
        val before = provider.load()
        val after = provider.save("Third Base")
        assertEquals(before.uuid, after.uuid)
        assertEquals("Third Base", after.name)
        assertEquals("Third Base", provider.load().name)
    }

    @Test
    fun `an empty name falls back rather than emitting an empty SDP session name`() {
        // RFC 4566 forbids an empty `s=`.
        val provider = DeviceIdentityProvider(InMemoryIdentityStore())
        val identity = provider.save("   ")
        assertEquals(DeviceIdentity.defaultName(identity.uuid), identity.name)
    }

    @Test
    fun `newlines in a name are folded, not carried into the SDP`() {
        // A CR or LF would terminate the SDP line early and split one field into two.
        val uuid = "c94df9ca-d7c2-468f-8529-97d01fba14e7"
        assertEquals("Third Base", DeviceIdentity.normalized("Third\r\nBase", uuid))
        assertEquals("Third Base", DeviceIdentity.normalized("Third\nBase", uuid))
        assertEquals("a b", DeviceIdentity.normalized("a\n\n\nb", uuid))
    }

    @Test
    fun `a malformed stored UUID is replaced rather than used`() {
        // A malformed CNAME would make TS Director bind two different phones to one record.
        for (bad in listOf("", "not-a-uuid", "C94DF9CA-D7C2-468F-8529-97D01FBA14E7", "1-1-1-1-1")) {
            val store = InMemoryIdentityStore(mapOf(DeviceIdentityProvider.uuidKey to bad))
            val loaded = DeviceIdentityProvider(store).load()
            assertTrue("rejected $bad", DeviceIdentityProvider.isWellFormed(loaded.uuid))
            assertFalse(loaded.uuid == bad)
        }
    }

    @Test
    fun `a well-formed lower-case UUID is accepted`() {
        assertTrue(DeviceIdentityProvider.isWellFormed("c94df9ca-d7c2-468f-8529-97d01fba14e7"))
    }

    @Test
    fun `the cname and the uuid are the same string`() {
        // RFC 5576 requires the SDP cname and the RTCP SDES CNAME to be identical.
        val identity = DeviceIdentity("c94df9ca-d7c2-468f-8529-97d01fba14e7", "x")
        assertEquals(identity.uuid, identity.cname)
    }

    /** A store whose every save fails, the way a `commit()` on a full disk does. */
    private class UnsavableIdentityStore : IdentityStore {
        override fun string(key: String): String? = null
        override fun setString(value: String, key: String) {}
    }

    @Test
    fun `a UUID whose save failed is the same one on the next launch`() {
        // Two providers over a store that never keeps anything are two launches after a failed
        // commit. A random mint would announce a different camera on each.
        val seed = "app.teamstation.cameraman:8f3a2b1c4d5e6f70:1757800000000"
        val first = DeviceIdentityProvider(UnsavableIdentityStore(), seed).load().uuid
        val second = DeviceIdentityProvider(UnsavableIdentityStore(), seed).load().uuid
        assertEquals(first, second)
        assertTrue(DeviceIdentityProvider.isWellFormed(first))
    }

    @Test
    fun `two installs never derive the same UUID`() {
        val one = DeviceIdentityProvider(InMemoryIdentityStore(), "pkg:8f3a2b1c4d5e6f70:1").load()
        val reinstalled = DeviceIdentityProvider(InMemoryIdentityStore(), "pkg:8f3a2b1c4d5e6f70:2").load()
        val otherPhone = DeviceIdentityProvider(InMemoryIdentityStore(), "pkg:0000000000000001:1").load()
        assertFalse(one.uuid == reinstalled.uuid)
        assertFalse(one.uuid == otherPhone.uuid)
    }

    @Test
    fun `a stored UUID is kept rather than re-derived`() {
        // Phones that already have an identity must not become new cameras on update.
        val existing = "c94df9ca-d7c2-468f-8529-97d01fba14e7"
        val store = InMemoryIdentityStore(mapOf(DeviceIdentityProvider.uuidKey to existing))
        assertEquals(existing, DeviceIdentityProvider(store, "pkg:8f3a2b1c4d5e6f70:1").load().uuid)
    }

    @Test
    fun `the derived UUID is what gets saved`() {
        val store = InMemoryIdentityStore()
        val uuid = DeviceIdentityProvider(store, "pkg:8f3a2b1c4d5e6f70:1").load().uuid
        assertEquals(uuid, store.string(DeviceIdentityProvider.uuidKey))
        assertEquals(DeviceIdentity.derivedUUID("pkg:8f3a2b1c4d5e6f70:1"), uuid)
    }
}

class FormatCatalogueTest {
    private val formats = listOf(
        CaptureFormatDescriptor(1920, 1080, 1.0, 30.0, supportsMultiLensSwitching = true),
        CaptureFormatDescriptor(1920, 1080, 1.0, 60.0, supportsMultiLensSwitching = true),
        CaptureFormatDescriptor(3840, 2160, 1.0, 30.0, supportsMultiLensSwitching = true),
        CaptureFormatDescriptor(1280, 720, 60.0, 240.0, supportsMultiLensSwitching = false),
        CaptureFormatDescriptor(1280, 720, 1.0, 30.0, supportsMultiLensSwitching = true)
    )
    private val catalogue = FormatCatalogue(formats)

    @Test
    fun `options are the offered formats the device can serve, in menu order`() {
        assertEquals(
            listOf("1080p 60 fps", "1080p 30 fps", "720p 60 fps", "720p 30 fps"),
            catalogue.options.map { it.label }
        )
    }

    @Test
    fun `sizes and rates the device advertises but the menu does not offer are left out`() {
        // 4K and 240 fps are both in the fixture and neither belongs on a sideline menu.
        assertTrue(catalogue.options.none { it.width > 1920 })
        assertEquals(setOf(30.0, 60.0), catalogue.options.map { it.frameRate }.toSet())
    }

    @Test
    fun `a 16 by 9 option reads as a broadcast format and anything else is spelled out`() {
        assertEquals("1080p 60 fps", FormatCatalogue.Option(1920, 1080, 60.0, true).label)
        assertEquals("720p 30 fps", FormatCatalogue.Option(1280, 720, 30.0, true).label)
        assertEquals("1440x1080 @ 30", FormatCatalogue.Option(1440, 1080, 30.0, true).label)
    }

    @Test
    fun `a size that keeps lens switching in one variant is reported as keeping it`() {
        val option = catalogue.options.first { it.width == 1280 && it.frameRate == 30.0 }
        assertTrue(option.supportsMultiLensSwitching)
        assertNull(option.annotation)
    }

    @Test
    fun `a size that only exists as a single-lens mode says so`() {
        // Losing lens switching should be a visible trade-off rather than a silent one.
        val option = catalogue.options.first { it.width == 1280 && it.frameRate == 60.0 }
        assertFalse(option.supportsMultiLensSwitching)
        assertEquals("single lens only", option.annotation)
    }

    @Test
    fun `selection prefers exact dimensions`() {
        val chosen = catalogue.selection(1920, 1080, 30.0)
        assertEquals(1920, chosen?.width)
        assertEquals(1080, chosen?.height)
    }

    @Test
    fun `selection prefers the tightest range that still contains the request`() {
        // A 240 fps format run at 30 wastes power and often drops lens switching; the 30 fps format
        // does neither.
        val chosen = catalogue.selection(1280, 720, 30.0)
        assertEquals(30.0, chosen?.maximumFrameRate)
        assertTrue(chosen!!.supportsMultiLensSwitching)
    }

    @Test
    fun `the documented default is 1080p30 keeping lens switching`() {
        val chosen = catalogue.defaultSelection
        assertEquals(1920, chosen?.width)
        assertEquals(30.0, chosen?.maximumFrameRate)
        assertTrue(chosen!!.supportsMultiLensSwitching)
    }

    @Test
    fun `an empty catalogue selects nothing rather than inventing a format`() {
        assertNull(FormatCatalogue(emptyList()).selection(1920, 1080, 30.0))
        assertNull(FormatCatalogue(emptyList()).defaultSelection)
    }

    @Test
    fun `the maximum is the largest whether or not it keeps switching`() {
        assertEquals(3840, catalogue.maximumSelection?.width)
    }
}

class LaunchConfigurationTest {

    @Test
    fun `defaults are the documented stream settings`() {
        val launch = LaunchConfiguration.from(emptyMap())
        assertEquals(1920, launch.settings.width)
        assertEquals(1080, launch.settings.height)
        assertEquals(30.0, launch.settings.frameRate, 1e-9)
        // HEVC by default: the same picture at two thirds the rate, which on a match-day Wi-Fi is
        // the difference between four cameras fitting and three.
        assertEquals(StreamCodec.HEVC, launch.settings.codec)
        assertEquals(StreamCodec.HEVC.defaultBitrate, launch.settings.bitrate)
        assertEquals(StreamSettings.defaultPort, launch.settings.port)
        assertTrue(launch.settings.audioEnabled)
        assertTrue(launch.advertise)
        assertFalse(launch.isUITest)
    }

    @Test
    fun `every documented key is read`() {
        val launch = LaunchConfiguration.from(
            mapOf(
                "uiTest" to "true",
                "syntheticCamera" to "yes",
                "rtspPort" to "9554",
                "rtspPath" to "/live/alt",
                "codec" to "hevc",
                "bitrateMbps" to "12.5",
                "width" to "1280",
                "height" to "720",
                "frameRate" to "60",
                "audioEnabled" to "0",
                "cameraName" to "Third Base",
                "identityUUID" to "c94df9ca-d7c2-468f-8529-97d01fba14e7",
                "measureCapabilities" to "1",
                "recordSeconds" to "8",
                "selfTest" to "true",
                "advertise" to "false"
            )
        )
        assertTrue(launch.isUITest)
        assertTrue(launch.useSyntheticCamera)
        assertEquals(9554, launch.settings.port)
        assertEquals("/live/alt", launch.settings.path)
        assertEquals(StreamCodec.HEVC, launch.settings.codec)
        assertEquals(12_500_000, launch.settings.bitrate)
        assertEquals(1280, launch.settings.width)
        assertEquals(60.0, launch.settings.frameRate, 1e-9)
        assertFalse(launch.settings.audioEnabled)
        assertEquals("Third Base", launch.cameraName)
        assertTrue(launch.measureCapabilities)
        assertEquals(8.0, launch.recordSeconds, 1e-9)
        assertTrue(launch.selfTest)
        assertFalse(launch.advertise)
        assertTrue(launch.unknownKeys.isEmpty())
    }

    @Test
    fun `an unrecognised key is reported rather than ignored`() {
        // A silently ignored launch argument produces a green run that proved nothing.
        val launch = LaunchConfiguration.from(mapOf("codecc" to "hevc", "zoom" to "2"))
        assertEquals(listOf("codecc", "zoom"), launch.unknownKeys)
        assertEquals(StreamCodec.HEVC, launch.settings.codec)
    }

    @Test
    fun `an explicit codec carries its default bitrate across`() {
        val launch = LaunchConfiguration.from(mapOf("codec" to "h264"))
        assertEquals(StreamCodec.H264.defaultBitrate, launch.settings.bitrate)
    }

    @Test
    fun `a named field is recorded so saved settings cannot override it`() {
        val launch = LaunchConfiguration.from(mapOf("codec" to "h264", "width" to "1280"))
        assertEquals(
            setOf(StreamSettings.Field.CODEC, StreamSettings.Field.WIDTH),
            launch.providedSettingFields
        )
    }

    @Test
    fun `a typo still counts as naming the field`() {
        // Otherwise a mistyped value would hand the decision back to whatever is on the handset,
        // which is the one thing a pinned launch argument exists to prevent.
        val launch = LaunchConfiguration.from(mapOf("codec" to "h2064"))
        assertTrue(launch.providedSettingFields.contains(StreamSettings.Field.CODEC))
    }

    @Test
    fun `persistence follows uiTest unless it is set explicitly`() {
        // A flow should neither inherit nor leave behind a preference — but the operator runs with
        // uiTest on to get the control server and still expects the camera to come back as left.
        assertTrue(LaunchConfiguration.from(emptyMap()).persistSettings)
        assertFalse(LaunchConfiguration.from(mapOf("uiTest" to "true")).persistSettings)
        assertTrue(
            LaunchConfiguration.from(
                mapOf("uiTest" to "true", "persistSettings" to "true")
            ).persistSettings
        )
    }

    @Test
    fun `disabled lenses arrive as a comma-separated list`() {
        val launch = LaunchConfiguration.from(mapOf("disabledLenses" to "uw, t ,"))
        assertEquals(setOf("uw", "t"), launch.settings.disabledLensIDs)
    }

    @Test
    fun `the floor is a launch key, and a pinned rate without one gets half of it`() {
        val pinned = LaunchConfiguration.from(mapOf("bitrateMbps" to "12", "bitrateFloorMbps" to "3.5"))
        assertEquals(12_000_000, pinned.settings.bitrate)
        assertEquals(3_500_000, pinned.settings.bitrateFloor)
        assertEquals(
            setOf(StreamSettings.Field.BITRATE_MBPS, StreamSettings.Field.BITRATE_FLOOR_MBPS),
            pinned.providedSettingFields
        )
        assertTrue(pinned.unknownKeys.isEmpty())

        assertEquals(6_000_000, LaunchConfiguration.from(mapOf("bitrateMbps" to "12")).settings.bitrateFloor)
        assertEquals(2_000_000, LaunchConfiguration.from(emptyMap()).settings.bitrateFloor)
        // Never above the rate.
        assertEquals(
            2_000_000,
            LaunchConfiguration.from(mapOf("bitrateMbps" to "2", "bitrateFloorMbps" to "5")).settings.bitrateFloor
        )
    }

    @Test
    fun `an explicit bitrate survives a codec change`() {
        val settings = StreamSettings.default.copy(bitrate = 12_000_000)
        settings.selectCodec(StreamCodec.HEVC)
        assertEquals(12_000_000, settings.bitrate)
    }

    @Test
    fun `the debug HUD follows uiTest unless it is set explicitly`() {
        assertTrue(LaunchConfiguration.from(mapOf("uiTest" to "true")).showDebugHUD)
        assertFalse(
            LaunchConfiguration.from(mapOf("uiTest" to "true", "debugHUD" to "false")).showDebugHUD
        )
    }

    @Test
    fun `booleans accept the spellings that appear in hand-written flows`() {
        for (truthy in listOf("1", "true", "TRUE", "yes")) {
            assertEquals(true, LaunchConfiguration.bool(truthy))
        }
        for (falsy in listOf("0", "false", "no")) {
            assertEquals(false, LaunchConfiguration.bool(falsy))
        }
        assertNull(LaunchConfiguration.bool("maybe"))
        assertNull(LaunchConfiguration.bool(null))
    }
}

class ControlChannelTest {
    private fun command(path: String) = ControlChannel.command("tscameraman://test$path")

    @Test
    fun `the argument-free commands parse`() {
        assertEquals(ControlCommand.DumpState, command("/dump-state"))
        assertEquals(ControlCommand.ShowSettings, command("/show-settings"))
        assertEquals(ControlCommand.HideSettings, command("/hide-settings"))
        assertEquals(ControlCommand.FlipCamera, command("/flip-camera"))
        assertEquals(ControlCommand.ForceKeyframe, command("/force-keyframe"))
        assertEquals(ControlCommand.Clients, command("/clients"))
        assertEquals(ControlCommand.Reset, command("/reset"))
    }

    @Test
    fun `set-zoom takes a displayed value`() {
        assertEquals(ControlCommand.SetZoom(2.5), command("/set-zoom?displayed=2.5"))
        // A typo fails where it was typed instead of three assertions later.
        assertNull(command("/set-zoom?displayd=2.5"))
        assertNull(command("/set-zoom"))
    }

    @Test
    fun `set-format defaults the rate a size normally runs at`() {
        assertEquals(
            ControlCommand.SetFormat(1920, 1080, 30),
            command("/set-format?width=1920&height=1080")
        )
        assertEquals(
            ControlCommand.SetFormat(1280, 720, 60),
            command("/set-format?width=1280&height=720&fps=60")
        )
        assertNull(command("/set-format?width=1920"))
    }

    @Test
    fun `set-codec lower-cases and set-bitrate parses a decimal`() {
        assertEquals(ControlCommand.SetCodec("hevc"), command("/set-codec?codec=HEVC"))
        assertNull(command("/set-codec?codec="))
        assertEquals(ControlCommand.SetBitrate(12.5), command("/set-bitrate?mbps=12.5"))
        assertNull(command("/set-bitrate?mbps=fast"))
    }

    @Test
    fun `set-adaptive-bitrate takes an on value`() {
        assertEquals(ControlCommand.SetAdaptiveBitrate(false), command("/set-adaptive-bitrate?on=false"))
        assertEquals(ControlCommand.SetAdaptiveBitrate(true), command("/set-adaptive-bitrate?on=yes"))
        assertNull(command("/set-adaptive-bitrate"))
    }

    @Test
    fun `an empty name is a real request, because it checks the fallback appears`() {
        assertEquals(ControlCommand.SetName(""), command("/set-name?name="))
        assertEquals(ControlCommand.SetName("Third Base"), command("/set-name?name=Third%20Base"))
    }

    @Test
    fun `set-audio reads the spellings flows actually contain`() {
        assertEquals(ControlCommand.SetAudio(true), command("/set-audio?on=yes"))
        assertEquals(ControlCommand.SetAudio(true), command("/set-audio?on=1"))
        assertEquals(ControlCommand.SetAudio(false), command("/set-audio?on=no"))
        assertNull(command("/set-audio"))
    }

    @Test
    fun `set-rotation clears its override when given no value`() {
        assertEquals(ControlCommand.SetRotation(90), command("/set-rotation?degrees=90"))
        assertEquals(ControlCommand.SetRotation(null), command("/set-rotation"))
    }

    @Test
    fun `radar commands parse and a serial that is not a TAG One is refused`() {
        assertEquals(
            ControlCommand.RadarShow("ADFAA003519", RadarPhase.connected, 0),
            command("/radar-show?serial=ADFAA003519&phase=connected&step=0")
        )
        assertEquals(
            ControlCommand.RadarFeed(50, 60, 1_000_000),
            command("/radar-feed?pitch=50&exit=60&now=1000000")
        )
        assertEquals(ControlCommand.RadarUnpair, command("/radar-unpair"))
        assertNull(command("/radar-show?serial=nope&phase=connected"))
    }

    @Test
    fun `a foreign scheme or an unknown action is refused`() {
        assertNull(ControlChannel.command("https://example.com/dump-state"))
        assertNull(command("/definitely-not-a-command"))
    }

    @Test
    fun `the request line is reduced to its target`() {
        assertEquals(
            "/set-zoom?displayed=2",
            ControlServer.requestTarget("GET /set-zoom?displayed=2 HTTP/1.1\r\nHost: x\r\n")
        )
        assertEquals("/", ControlServer.requestTarget("nonsense"))
    }
}

/**
 * The capture rotation is a derived rule with one measured anchor, so it is pinned here: a change
 * that puts the stream back on its side should fail in a suite rather than on a field.
 */
class CaptureRotationTest {

    @Test
    fun `a Pixel 10 in landscape needs a quarter turn`() {
        // MEASURED 2026-09-05 on a Pixel 10: sensor 90, window ROTATION_90, and the encoded frame
        // needed a further 90 degrees. See docs/capabilities.md.
        assertEquals(
            90,
            CameraSession.captureRotation(
                sensorOrientation = 90,
                displayRotation = 90,
                isFront = false
            )
        )
    }

    @Test
    fun `the other landscape hold is 180 degrees away`() {
        // The two holds must differ by exactly a half turn, or flipping the phone on the tripod
        // would produce something other than an upside-down picture.
        val one = CameraSession.captureRotation(90, 90, isFront = false)
        val other = CameraSession.captureRotation(90, 270, isFront = false)
        assertEquals(180, ((other - one) + 360) % 360)
    }

    @Test
    fun `the front camera takes the same angle as the back in the same hold`() {
        // MEASURED 2026-09-05: flipping to the front camera produced an upright picture at the same
        // 90 degrees. The 180 between a front sensor's 270 and a back sensor's 90 is cancelled by
        // the sign flip in the formula, so what actually separates the two cameras is the mirror,
        // not the rotation — and mirroring is not a rotation, so it is not modelled as one.
        val back = CameraSession.captureRotation(90, 90, isFront = false)
        val front = CameraSession.captureRotation(270, 90, isFront = true)
        assertEquals(back, front)
        assertEquals(90, front)
    }

    @Test
    fun `only the two landscape holds move the capture rotation`() {
        // The picture stays landscape even while Settings is portrait. A portrait reading — a
        // phone tipped upright while it is being re-clamped — must be held rather than applied,
        // or the stream sends a quarter-turned picture on the way past. Flat on a bench reports
        // ORIENTATION_UNKNOWN and is held too.
        assertNull(CameramanService.landscapeSurfaceRotation(0))
        assertNull(CameramanService.landscapeSurfaceRotation(180))
        assertNull(CameramanService.landscapeSurfaceRotation(359))
        assertNull(
            CameramanService.landscapeSurfaceRotation(OrientationEventListener.ORIENTATION_UNKNOWN)
        )
    }

    @Test
    fun `the two landscape holds map to opposite surface rotations`() {
        val one = CameramanService.landscapeSurfaceRotation(90)
        val other = CameramanService.landscapeSurfaceRotation(270)
        assertEquals(Surface.ROTATION_270, one)
        assertEquals(Surface.ROTATION_90, other)
        // Which is what makes the pictures they produce a half turn apart, via captureRotation.
        val oneAngle = CameraSession.captureRotation(90, 270, isFront = false)
        val otherAngle = CameraSession.captureRotation(90, 90, isFront = false)
        assertEquals(180, ((otherAngle - oneAngle) + 360) % 360)
    }

    @Test
    fun `the result is always a legal quarter turn`() {
        for (sensor in listOf(0, 90, 180, 270)) {
            for (display in listOf(0, 90, 180, 270)) {
                for (front in listOf(false, true)) {
                    val angle = CameraSession.captureRotation(sensor, display, front)
                    assertTrue("$sensor/$display/$front -> $angle", angle in listOf(0, 90, 180, 270))
                }
            }
        }
    }
}
