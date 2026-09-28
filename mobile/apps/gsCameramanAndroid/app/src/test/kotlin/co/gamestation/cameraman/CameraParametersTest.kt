package co.gamestation.cameraman

import co.gamestation.cameraman.capture.FormatCatalogue
import co.gamestation.cameraman.core.BatteryStatus
import co.gamestation.cameraman.core.CameraLens
import co.gamestation.cameraman.core.CameraParameterError
import co.gamestation.cameraman.core.CameraParameterName
import co.gamestation.cameraman.core.CameraParameterSet
import co.gamestation.cameraman.core.CameraParameterWrite
import co.gamestation.cameraman.core.CameraParameters
import co.gamestation.cameraman.core.CameraPosition
import co.gamestation.cameraman.core.CameraSnapshot
import co.gamestation.cameraman.core.DeviceIdentity
import co.gamestation.cameraman.core.StreamCodec
import co.gamestation.cameraman.core.StreamSettings
import co.gamestation.cameraman.core.ThermalBadgeLevel
import co.gamestation.cameraman.core.ZoomMapping
import co.gamestation.cameraman.core.fromSdpEncodingName
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wire vocabulary, on both sides: what the phone emits, what a client reads back, and what a
 * write is allowed to do.
 *
 * The fixture and the expected values are the iOS suite's, number for number. The two builds answer
 * the same client, so a divergence here is a divergence Director would see.
 */
class CameraParametersTest {

    companion object {
        /** An iPhone 13 Pro-shaped camera: 0.5x / 1x / 3x back lenses, 9x digital ceiling, front 1x. */
        fun snapshot(
            settings: StreamSettings = StreamSettings(),
            position: CameraPosition = CameraPosition.BACK,
            deviceZoom: Double = 2.0
        ): CameraSnapshot = CameraSnapshot(
            name = "Third Base",
            cname = "c94df9ca-d7c2-468f-8529-97d01fba14e7",
            model = "Pixel 10",
            thermalName = "fair",
            status = "running",
            battery = BatteryStatus(percent = 87, isCharging = false),
            position = position,
            deviceType = "builtInTripleCamera (0)",
            mapping = ZoomMapping(
                minimumDeviceZoom = 1.0,
                maximumDeviceZoom = 18.0,
                displayMultiplier = 0.5,
                switchOverDeviceZooms = listOf(2.0, 6.0)
            ),
            deviceZoom = deviceZoom,
            settings = settings,
            formats = listOf(
                FormatCatalogue.Option(1920, 1080, 30.0, true),
                FormatCatalogue.Option(1920, 1080, 60.0, true),
                FormatCatalogue.Option(3840, 2160, 30.0, false)
            ),
            lenses = listOf(
                CameraLens("uw", CameraPosition.BACK, "2", 13, 0.5, 1.0),
                CameraLens("wide", CameraPosition.BACK, "0", 26, 1.0, 2.0),
                CameraLens("tele", CameraPosition.BACK, "3", 77, 3.0, 6.0),
                CameraLens("front", CameraPosition.FRONT, "1", null, 1.0, 1.0)
            ),
            streamURL = "rtsp://10.10.7.118:8554/live/mainstream",
            clientCount = 2
        )
    }

    private fun set(body: String): CameraParameterWrite {
        val write = CameraParameters.parseSet(body, snapshot()).getOrNull()
        assertNotNull("expected `$body` to parse", write)
        return write!!
    }

    private fun failure(body: String, snapshot: CameraSnapshot = snapshot()): CameraParameterError? =
        CameraParameters.parseSet(body, snapshot).errorOrNull()

    @Test
    fun `the full set round-trips through the client decoder`() {
        val original = snapshot()
        val text = CameraParameters.encode(original).encoded
        val parsed = CameraParameterSet.decode(text).getOrNull()!!
        val decoded = CameraParameters.decodeSnapshot(parsed)
        assertNotNull(decoded)
        decoded!!

        assertEquals(original.name, decoded.name)
        assertEquals(original.cname, decoded.cname)
        assertEquals(original.model, decoded.model)
        assertEquals("fair", decoded.thermalName)
        assertEquals(BatteryStatus(87, false), decoded.battery)
        assertEquals(CameraPosition.BACK, decoded.position)
        assertEquals(original.mapping, decoded.mapping)
        assertEquals(2.0, decoded.deviceZoom, 0.0)
        assertEquals(1.0, decoded.displayedZoom, 0.0)
        assertEquals(StreamCodec.HEVC, decoded.settings.codec)
        assertEquals(4_000_000, decoded.settings.bitrate)
        assertEquals(1920, decoded.settings.width)
        assertEquals(30.0, decoded.settings.frameRate, 0.0)
        assertEquals(8554, decoded.settings.port)
        assertEquals("/live/mainstream", decoded.settings.path)
        assertEquals(original.formats, decoded.formats)
        assertEquals(listOf("uw", "wide", "tele", "front"), decoded.lenses.map { it.id })
        assertEquals(77, decoded.lenses[2].focalLengthMM)
        assertNull(decoded.lenses[3].focalLengthMM)
        assertEquals(2, decoded.clientCount)
        assertEquals(original.streamURL, decoded.streamURL)
    }

    @Test
    fun `the software zoom start round-trips, and none is sent empty`() {
        assertEquals("", CameraParameters.encode(snapshot())[CameraParameterName.zoomSoftwareStartDevice])
        val extended = snapshot().copy(mapping = snapshot().mapping.extendedBySoftwareZoom())
        val set = CameraParameters.encode(extended)
        assertEquals("18", set[CameraParameterName.zoomSoftwareStartDevice])
        assertEquals(extended.mapping, CameraParameters.decodeSnapshot(set)?.mapping)
    }

    @Test
    fun `values are ONVIF-shaped on the wire`() {
        val set = CameraParameters.encode(snapshot())
        assertEquals("H265", set["videoEncoder.encoding"])
        // kbps, as ONVIF.
        assertEquals("4000", set["videoEncoder.rateControl.bitrateLimit"])
        assertEquals("1", set["ptz.zoom"])
        assertEquals("2", set["ptz.zoom.device"])
        assertEquals("0.5", set["videoSource.zoom.displayMultiplier"])
        assertEquals("2,6", set["videoSource.zoom.switchOverDevice"])
        assertEquals("87", set["system.battery"])
        assertEquals("4", set["lens.count"])
        assertEquals("13 mm", set["lens.0.title"])
        // Camera2 has no device types; the physical id stands in, and nothing is a native crop.
        assertEquals("2", set["lens.0.deviceType"])
        assertEquals("false", set["lens.0.native"])
        assertEquals("3", set["videoEncoder.formats"])
        assertEquals("false", set["format.2.multiLens"])
        assertEquals("2", set["stream.clients"])
        assertEquals("device.name", set.names.first())
    }

    @Test
    fun `an unknown battery is an empty value, and decodes to null`() {
        val set = CameraParameters.encode(snapshot().copy(battery = null))
        assertEquals("", set["system.battery"])
        val decoded = CameraParameters.decodeSnapshot(set)
        assertNotNull(decoded)
        assertNull(decoded!!.battery)
    }

    @Test
    fun `a GET body names a subset in request order, and star is everything`() {
        val snapshot = snapshot()
        val subset = CameraParameters.respondToGet("system.thermal\r\nptz.zoom\r\n", snapshot).getOrNull()!!
        assertEquals(listOf("system.thermal", "ptz.zoom"), subset.names)
        assertEquals("1", subset["ptz.zoom"])

        val everything = CameraParameters.respondToGet("*\n", snapshot).getOrNull()!!
        assertEquals(CameraParameters.encode(snapshot).count, everything.count)

        // Some clients send `name:` when asking.
        val colon = CameraParameters.respondToGet("device.name:\r\n", snapshot).getOrNull()!!
        assertEquals("Third Base", colon["device.name"])
    }

    @Test
    fun `an unknown name in a GET is 451`() {
        val error = CameraParameters.respondToGet("ptz.zom\r\n", snapshot()).errorOrNull()
        assertNotNull(error)
        assertEquals(451, error!!.statusCode)
        assertEquals("ptz.zom", error.name)
        assertTrue(error.body.startsWith("ptz.zom\r\n"))
    }

    @Test
    fun `a SET decodes CRLF or LF, trims, and refuses a repeated name`() {
        val write = set("ptz.zoom: 3\n device.name :  Left Field \r\n")
        assertEquals(3.0, write.displayedZoom!!, 0.0)
        assertEquals("Left Field", write.name)
        assertEquals(listOf("ptz.zoom", "device.name"), write.requestedNames)

        assertEquals(400, failure("ptz.zoom: 3\r\nptz.zoom: 4\r\n")?.statusCode)
        assertEquals(400, failure("no colon here\r\n")?.statusCode)
    }

    @Test
    fun `read-only names are 458, unknown names 451, and nothing is applied`() {
        val readOnly = failure("device.cname: 1234\r\n")
        assertEquals(458, readOnly?.statusCode)
        assertEquals("device.cname", readOnly?.name)

        // The good line first must not be applied when a later line is bad.
        val mixed = failure("ptz.zoom: 3\r\nnope.nope: 1\r\n")
        assertEquals(451, mixed?.statusCode)
        assertEquals("nope.nope", mixed?.name)

        // Indexed descriptors are read-only.
        assertEquals(458, failure("lens.0.id: x\r\n")?.statusCode)
    }

    @Test
    fun `codec and bitrate - H265 is HEVC, kbps become bps, and the default rate carries`() {
        var write = set("videoEncoder.encoding: H264\r\n")
        assertEquals(StreamCodec.H264, write.codec)
        var applied = CameraParameters.settings(write, StreamSettings())
        assertEquals(StreamCodec.H264, applied.codec)
        // The codec's default carries like the picker.
        assertEquals(StreamCodec.H264.defaultBitrate, applied.bitrate)

        write = set("videoEncoder.encoding: h265\r\nvideoEncoder.rateControl.bitrateLimit: 2500\r\n")
        applied = CameraParameters.settings(
            write,
            StreamSettings(codec = StreamCodec.H264, bitrate = 6_000_000)
        )
        assertEquals(StreamCodec.HEVC, applied.codec)
        // An explicit rate in the same request wins.
        assertEquals(2_500_000, applied.bitrate)

        assertEquals(400, failure("videoEncoder.encoding: VP9\r\n")?.statusCode)
        assertEquals(400, failure("videoEncoder.rateControl.bitrateLimit: 900\r\n")?.statusCode)
        assertEquals(400, failure("videoEncoder.rateControl.bitrateLimit: 50001\r\n")?.statusCode)
        assertEquals(400, failure("videoEncoder.rateControl.bitrateLimit: lots\r\n")?.statusCode)
    }

    @Test
    fun `adaptive bitrate is writable, the rate the encoder is running at is read-only`() {
        val encoded = CameraParameters.encode(snapshot())
        // On by default, and at the ceiling while nothing has adapted.
        assertEquals("true", encoded["videoEncoder.rateControl.adaptive"])
        assertEquals("4000", encoded["videoEncoder.rateControl.currentBitrate"])

        val adapting = snapshot().copy(currentBitrate = 2_600_000)
        assertEquals("2600", CameraParameters.encode(adapting)["videoEncoder.rateControl.currentBitrate"])
        val parsed = CameraParameterSet.decode(CameraParameters.encode(adapting).encoded).getOrNull()!!
        val decoded = CameraParameters.decodeSnapshot(parsed)!!
        assertEquals(2_600_000, decoded.currentBitrate)
        assertTrue(decoded.settings.adaptiveBitrate)

        val write = set("videoEncoder.rateControl.adaptive: false\r\n")
        assertTrue(write.touchesSettings)
        assertEquals(false, CameraParameters.settings(write, StreamSettings()).adaptiveBitrate)
        assertEquals(400, failure("videoEncoder.rateControl.adaptive: sometimes\r\n")?.statusCode)
        assertEquals(458, failure("videoEncoder.rateControl.currentBitrate: 1000\r\n")?.statusCode)
    }

    @Test
    fun `the bitrate floor is kbps on the wire, writable, and never above the rate it sits under`() {
        val encoded = CameraParameters.encode(snapshot())
        // Half the rate by default.
        assertEquals("2000", encoded["videoEncoder.rateControl.bitrateFloor"])
        assertTrue(CameraParameterName.bitrateFloorKbps in CameraParameterName.writable)

        val chosen = snapshot(settings = StreamSettings(bitrateFloor = 1_500_000))
        assertEquals(1_500_000, CameraParameters.decodeSnapshot(CameraParameters.encode(chosen))!!.settings.bitrateFloor)

        var write = set("videoEncoder.rateControl.bitrateFloor: 1500\r\n")
        assertEquals(1_500_000, write.bitrateFloor)
        assertTrue(write.touchesSettings)
        assertEquals(1_500_000, CameraParameters.settings(write, StreamSettings()).bitrateFloor)
        val applied = CameraParameters.snapshot(write, snapshot())
        assertEquals("1500", CameraParameters.echo(write, applied)["videoEncoder.rateControl.bitrateFloor"])

        assertEquals(400, failure("videoEncoder.rateControl.bitrateFloor: 900\r\n")?.statusCode)
        assertEquals(400, failure("videoEncoder.rateControl.bitrateFloor: 50001\r\n")?.statusCode)
        assertEquals(400, failure("videoEncoder.rateControl.bitrateFloor: some\r\n")?.statusCode)
        // Above the 4000 kbps rate.
        val above = failure("videoEncoder.rateControl.bitrateFloor: 5000\r\n")
        assertEquals(400, above?.statusCode)
        assertEquals("videoEncoder.rateControl.bitrateFloor", above?.name)

        // Judged on the result: raising both together is fine, in either order on the wire.
        write = set("videoEncoder.rateControl.bitrateFloor: 5000\r\nvideoEncoder.rateControl.bitrateLimit: 8000\r\n")
        var next = CameraParameters.settings(write, StreamSettings())
        assertEquals(8_000_000, next.bitrate)
        assertEquals(5_000_000, next.bitrateFloor)
        assertEquals(
            400,
            failure("videoEncoder.rateControl.bitrateLimit: 3000\r\nvideoEncoder.rateControl.bitrateFloor: 3500\r\n")?.statusCode
        )

        // A request naming only the rate is never refused for the floor, which comes down with it.
        val high = StreamSettings(bitrate = 10_000_000, bitrateFloor = 6_000_000)
        write = CameraParameters.parseSet("videoEncoder.rateControl.bitrateLimit: 3000\r\n", snapshot(settings = high))
            .getOrNull()!!
        next = CameraParameters.settings(write, high)
        assertEquals(3_000_000, next.bitrate)
        assertEquals(3_000_000, next.bitrateFloor)
        // A default floor follows the rate at half.
        assertEquals(1_500_000, CameraParameters.settings(write, high.copy(bitrateFloor = 5_000_000)).bitrateFloor)
    }

    @Test
    fun `a phone that predates the floor is read as adapting down to half its rate`() {
        val withoutIt = CameraParameterSet()
        val full = CameraParameters.encode(
            snapshot(settings = StreamSettings(bitrate = 9_000_000, bitrateFloor = 1_000_000))
        )
        for ((name, value) in full.pairs) {
            if (name != CameraParameterName.bitrateFloorKbps) withoutIt.set(name, value)
        }
        assertEquals(4_500_000, CameraParameters.decodeSnapshot(withoutIt)!!.settings.bitrateFloor)
    }

    @Test
    fun `zoom is clamped to the mapping on apply, and non-numbers are 400`() {
        val write = set("ptz.zoom: 40\r\n")
        val applied = CameraParameters.snapshot(write, snapshot())
        // Clamped to the mapping's ceiling, not the hardware's digital one.
        assertEquals(9.0, applied.displayedZoom, 0.0)
        assertEquals(9.0, applied.settings.displayedZoom, 0.0)

        val small = CameraParameters.snapshot(set("ptz.zoom: 0.1\r\n"), snapshot())
        assertEquals(0.5, small.displayedZoom, 0.0)

        assertEquals(400, failure("ptz.zoom: wide\r\n")?.statusCode)
        assertEquals(400, failure("ptz.zoom: -1\r\n")?.statusCode)
    }

    @Test
    fun `a format must be one the camera offers, merged with the current fields`() {
        // 1080p60 exists, so changing only the rate is fine.
        val rate = set("videoEncoder.rateControl.frameRateLimit: 60\r\n")
        assertEquals(60.0, rate.frameRate!!, 0.0)

        // 4K60 does not exist.
        val bad = failure(
            "videoEncoder.resolution.width: 3840\r\nvideoEncoder.resolution.height: 2160\r\n" +
                "videoEncoder.rateControl.frameRateLimit: 60\r\n"
        )
        assertEquals(400, bad?.statusCode)
        assertEquals("videoEncoder.rateControl.frameRateLimit", bad?.name)

        // 4K30 does.
        val ok = set("videoEncoder.resolution.width: 3840\r\nvideoEncoder.resolution.height: 2160\r\n")
        val applied = CameraParameters.settings(ok, StreamSettings())
        assertEquals(3840, applied.width)
        assertEquals(2160, applied.height)
        assertEquals(30.0, applied.frameRate, 0.0)

        // A synthetic camera offers no formats; anything goes there rather than nothing.
        val empty = snapshot().copy(formats = emptyList())
        val synthetic = CameraParameters.parseSet("videoEncoder.resolution.width: 640\r\n", empty)
        assertEquals(640, synthetic.getOrNull()?.width)
    }

    @Test
    fun `lenses - unknown ids and the last lens at a position are 400`() {
        val write = set("lens.disabled: uw, tele\r\n")
        assertEquals(setOf("uw", "tele"), write.disabledLensIDs)
        // No back lens left.
        assertEquals(400, failure("lens.disabled: uw,wide,tele\r\n")?.statusCode)
        // No front lens left.
        assertEquals(400, failure("lens.disabled: front\r\n")?.statusCode)
        assertEquals(400, failure("lens.disabled: periscope\r\n")?.statusCode)
        val none = set("lens.disabled: \r\n")
        assertEquals(emptySet<String>(), none.disabledLensIDs)
    }

    @Test
    fun `position and audio parse, and the echo names only what was written`() {
        val write = set("videoSource.position: front\r\naudioEncoder.enabled: false\r\ndevice.name:   \r\n")
        assertEquals(CameraPosition.FRONT, write.position)
        assertEquals(false, write.audioEnabled)
        assertTrue(write.touchesSettings)

        val applied = CameraParameters.snapshot(write, snapshot())
        assertEquals(CameraPosition.FRONT, applied.position)
        assertEquals(false, applied.settings.audioEnabled)
        // An empty name falls back like the phone.
        assertEquals(DeviceIdentity.defaultName(applied.cname), applied.name)

        val echo = CameraParameters.echo(write, applied)
        assertEquals(listOf("videoSource.position", "audioEncoder.enabled", "device.name"), echo.names)
        assertEquals("front", echo["videoSource.position"])
        assertEquals("false", echo["audioEncoder.enabled"])

        assertEquals(400, failure("videoSource.position: sideways\r\n")?.statusCode)
        assertEquals(400, failure("audioEncoder.enabled: maybe\r\n")?.statusCode)
    }

    @Test
    fun `numbers print without trailing zeros`() {
        assertEquals("1", CameraParameters.number(1.0))
        assertEquals("0.5", CameraParameters.number(0.5))
        assertEquals("2.75", CameraParameters.number(2.75))
        assertEquals("29.97", CameraParameters.number(29.97))
        assertEquals("1", CameraParameters.number(1.0004))
    }

    @Test
    fun `the thermal name maps to the pill level the phone draws`() {
        val decoded = CameraParameters.decodeSnapshot(CameraParameters.encode(snapshot()))
        assertEquals(ThermalBadgeLevel.FAIR, ThermalBadgeLevel.fromTelemetryName(decoded?.thermalName ?: ""))
    }

    @Test
    fun `the SDP encoding name parses in either case, with HEVC as a courtesy`() {
        assertEquals(StreamCodec.H264, StreamCodec.fromSdpEncodingName("h264"))
        assertEquals(StreamCodec.HEVC, StreamCodec.fromSdpEncodingName("H265"))
        assertEquals(StreamCodec.HEVC, StreamCodec.fromSdpEncodingName("hevc"))
        assertNull(StreamCodec.fromSdpEncodingName("AV1"))
    }
}
