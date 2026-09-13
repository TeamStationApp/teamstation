import CameramanCore
import Foundation
import Testing

/// The wire vocabulary, on both sides: what the phone emits, what a client reads back, and what a
/// write is allowed to do.
@Suite("Camera parameters")
struct CameraParametersTests {
  /// An iPhone 13 Pro-shaped camera: 0.5x / 1x / 3x back lenses, 9x digital ceiling, front 1x.
  static func snapshot(
    settings: StreamSettings = StreamSettings(),
    position: CameraPosition = .back,
    deviceZoom: Double = 2
  ) -> CameraSnapshot {
    CameraSnapshot(
      name: "Third Base",
      cname: "c94df9ca-d7c2-468f-8529-97d01fba14e7",
      model: "iPhone14,2",
      thermalName: "fair",
      status: "running",
      battery: BatteryStatus(percent: 87, isCharging: false),
      position: position,
      deviceType: CameraDeviceTypeName.triple,
      mapping: ZoomMapping(
        minimumDeviceZoom: 1,
        maximumDeviceZoom: 18,
        displayMultiplier: 0.5,
        switchOverDeviceZooms: [ 2, 6 ]
      ),
      deviceZoom: deviceZoom,
      settings: settings,
      formats: [
        FormatCatalogue.Option(width: 1920, height: 1080, frameRate: 30, supportsMultiLensSwitching: true),
        FormatCatalogue.Option(width: 1920, height: 1080, frameRate: 60, supportsMultiLensSwitching: true),
        FormatCatalogue.Option(width: 3840, height: 2160, frameRate: 30, supportsMultiLensSwitching: false)
      ],
      lenses: [
        CameraLens(id: "uw", position: .back, deviceType: CameraDeviceTypeName.ultraWide, uniqueDeviceID: "uw", focalLengthMM: 13, displayedZoom: 0.5, deviceZoom: 1, isSecondaryNative: false),
        CameraLens(id: "wide", position: .back, deviceType: CameraDeviceTypeName.wideAngle, uniqueDeviceID: "wide", focalLengthMM: 26, displayedZoom: 1, deviceZoom: 2, isSecondaryNative: false),
        CameraLens(id: "tele", position: .back, deviceType: CameraDeviceTypeName.telephoto, uniqueDeviceID: "tele", focalLengthMM: 77, displayedZoom: 3, deviceZoom: 6, isSecondaryNative: false),
        CameraLens(id: "front", position: .front, deviceType: CameraDeviceTypeName.wideAngle, uniqueDeviceID: "front", focalLengthMM: nil, displayedZoom: 1, deviceZoom: 1, isSecondaryNative: false)
      ],
      streamURL: "rtsp://192.168.7.118:554/live/mainstream",
      clientCount: 2
    )
  }

  private func set(_ body: String) throws -> CameraParameterWrite {
    try CameraParameters.parseSet(body: body, snapshot: Self.snapshot()).get()
  }

  private func failure(_ body: String, snapshot: CameraSnapshot = snapshot()) -> CameraParameterError? {
    if case .failure(let error) = CameraParameters.parseSet(body: body, snapshot: snapshot) { return error }
    return nil
  }

  @Test("The full set round-trips through the client decoder")
  func fullSetRoundTrips() throws {
    let original = Self.snapshot()
    let encoded = CameraParameters.encode(original)
    let text = encoded.encoded
    let parsed = try CameraParameterSet.decode(text).get()
    let decoded = try #require(CameraParameters.decodeSnapshot(parsed))

    #expect(decoded.name == original.name)
    #expect(decoded.cname == original.cname)
    #expect(decoded.model == original.model)
    #expect(decoded.thermalName == "fair")
    #expect(decoded.battery == BatteryStatus(percent: 87, isCharging: false))
    #expect(decoded.position == .back)
    #expect(decoded.mapping == original.mapping)
    #expect(decoded.deviceZoom == 2)
    #expect(decoded.displayedZoom == 1)
    #expect(decoded.settings.codec == .hevc)
    #expect(decoded.settings.bitrate == 4_000_000)
    #expect(decoded.settings.width == 1920)
    #expect(decoded.settings.frameRate == 30)
    #expect(decoded.settings.port == 554)
    #expect(decoded.settings.path == "/live/mainstream")
    #expect(decoded.formats == original.formats)
    #expect(decoded.lenses.map(\.id) == [ "uw", "wide", "tele", "front" ])
    #expect(decoded.lenses[2].focalLengthMM == 77)
    #expect(decoded.lenses[3].focalLengthMM == nil)
    #expect(decoded.clientCount == 2)
    #expect(decoded.streamURL == original.streamURL)
    #expect(decoded.settings.cleanHDMIEnabled)
  }

  @Test("Values are ONVIF-shaped on the wire")
  func wireValues() {
    let set = CameraParameters.encode(Self.snapshot())
    #expect(set["videoEncoder.encoding"] == "H265")
    #expect(set["videoEncoder.rateControl.bitrateLimit"] == "4000", "kbps, as ONVIF")
    #expect(set["ptz.zoom"] == "1")
    #expect(set["ptz.zoom.device"] == "2")
    #expect(set["videoSource.zoom.displayMultiplier"] == "0.5")
    #expect(set["videoSource.zoom.switchOverDevice"] == "2,6")
    #expect(set["system.battery"] == "87")
    #expect(set["lens.count"] == "4")
    #expect(set["lens.0.title"] == "13 mm")
    #expect(set["videoEncoder.formats"] == "3")
    #expect(set["format.2.multiLens"] == "false")
    #expect(set["stream.clients"] == "2")
    #expect(set["videoOutput.hdmi.clean"] == "true")
    #expect(set.names.first == "device.name")
  }

  @Test("The clean HDMI toggle is written as a settings change, and an old phone's silence reads as on")
  func cleanHDMI() throws {
    let write = try set("videoOutput.hdmi.clean: off\r\n")
    #expect(write.cleanHDMIEnabled == false)
    #expect(write.touchesSettings)
    #expect(write.isEmpty == false)
    let applied = CameraParameters.snapshot(applying: write, to: Self.snapshot())
    #expect(applied.settings.cleanHDMIEnabled == false)
    #expect(CameraParameters.echo(write, applied: applied)["videoOutput.hdmi.clean"] == "false")
    #expect(failure("videoOutput.hdmi.clean: maybe\r\n")?.kind == .badRequest)

    // A phone that predates the name leaves it out of `*`; the client must not read that as off.
    var withoutIt = CameraParameterSet()
    for (name, value) in CameraParameters.encode(Self.snapshot()).pairs
    where name != CameraParameterName.videoOutputHDMIClean {
      withoutIt.set(name, value)
    }
    #expect(try #require(CameraParameters.decodeSnapshot(withoutIt)).settings.cleanHDMIEnabled)
  }

  @Test("An unknown battery is an empty value, and decodes to nil")
  func unknownBattery() throws {
    var snapshot = Self.snapshot()
    snapshot.battery = nil
    let set = CameraParameters.encode(snapshot)
    #expect(set["system.battery"] == "")
    let decoded = try #require(CameraParameters.decodeSnapshot(set))
    #expect(decoded.battery == nil)
  }

  @Test("A GET body names a subset in request order, and * is everything")
  func getSubsets() throws {
    let snapshot = Self.snapshot()
    let subset = try CameraParameters.respondToGet(body: "system.thermal\r\nptz.zoom\r\n", snapshot: snapshot).get()
    #expect(subset.pairs.map(\.name) == [ "system.thermal", "ptz.zoom" ])
    #expect(subset["ptz.zoom"] == "1")

    let everything = try CameraParameters.respondToGet(body: "*\n", snapshot: snapshot).get()
    #expect(everything.count == CameraParameters.encode(snapshot).count)

    // Some clients send `name:` when asking.
    let colon = try CameraParameters.respondToGet(body: "device.name:\r\n", snapshot: snapshot).get()
    #expect(colon["device.name"] == "Third Base")
  }

  @Test("An unknown name in a GET is 451")
  func getUnknownIs451() {
    guard case .failure(let error) = CameraParameters.respondToGet(body: "ptz.zom\r\n", snapshot: Self.snapshot()) else {
      Issue.record("expected a failure")
      return
    }
    #expect(error.statusCode == 451)
    #expect(error.name == "ptz.zom")
    #expect(error.body.hasPrefix("ptz.zom\r\n"))
  }

  @Test("A SET decodes CRLF or LF, trims, and refuses a repeated name")
  func setDecoding() throws {
    let write = try set("ptz.zoom: 3\n device.name :  Left Field \r\n")
    #expect(write.displayedZoom == 3)
    #expect(write.name == "Left Field")
    #expect(write.requestedNames == [ "ptz.zoom", "device.name" ])

    #expect(failure("ptz.zoom: 3\r\nptz.zoom: 4\r\n")?.statusCode == 400)
    #expect(failure("no colon here\r\n")?.statusCode == 400)
  }

  @Test("Read-only names are 458, unknown names 451, and nothing is applied")
  func readOnlyAndUnknown() {
    let readOnly = failure("device.cname: 1234\r\n")
    #expect(readOnly?.statusCode == 458)
    #expect(readOnly?.name == "device.cname")

    // The good line first must not be applied when a later line is bad.
    let mixed = failure("ptz.zoom: 3\r\nnope.nope: 1\r\n")
    #expect(mixed?.statusCode == 451)
    #expect(mixed?.name == "nope.nope")

    #expect(failure("lens.0.id: x\r\n")?.statusCode == 458, "indexed descriptors are read-only")
  }

  @Test("Codec and bitrate: H265 is HEVC, kbps become bps, and the default rate carries")
  func codecAndBitrate() throws {
    var write = try set("videoEncoder.encoding: H264\r\n")
    #expect(write.codec == .h264)
    var applied = CameraParameters.settings(applying: write, to: StreamSettings())
    #expect(applied.codec == .h264)
    #expect(applied.bitrate == StreamCodec.h264.defaultBitrate, "the codec's default carries like the picker")

    write = try set("videoEncoder.encoding: h265\r\nvideoEncoder.rateControl.bitrateLimit: 2500\r\n")
    applied = CameraParameters.settings(applying: write, to: StreamSettings(codec: .h264, bitrate: 6_000_000))
    #expect(applied.codec == .hevc)
    #expect(applied.bitrate == 2_500_000, "an explicit rate in the same request wins")

    #expect(failure("videoEncoder.encoding: VP9\r\n")?.statusCode == 400)
    #expect(failure("videoEncoder.rateControl.bitrateLimit: 900\r\n")?.statusCode == 400)
    #expect(failure("videoEncoder.rateControl.bitrateLimit: 50001\r\n")?.statusCode == 400)
    #expect(failure("videoEncoder.rateControl.bitrateLimit: lots\r\n")?.statusCode == 400)
  }

  @Test("Adaptive bitrate is writable; the rate the encoder is running at is read-only")
  func adaptiveBitrate() throws {
    let encoded = CameraParameters.encode(Self.snapshot())
    #expect(encoded["videoEncoder.rateControl.adaptive"] == "true", "on by default")
    #expect(encoded["videoEncoder.rateControl.currentBitrate"] == "4000", "the ceiling while nothing has adapted")

    var adapting = Self.snapshot()
    adapting.currentBitrate = 2_600_000
    let text = CameraParameters.encode(adapting).encoded
    #expect(CameraParameters.encode(adapting)["videoEncoder.rateControl.currentBitrate"] == "2600")
    let decoded = try #require(CameraParameters.decodeSnapshot(try CameraParameterSet.decode(text).get()))
    #expect(decoded.currentBitrate == 2_600_000)
    #expect(decoded.settings.adaptiveBitrate)

    let write = try set("videoEncoder.rateControl.adaptive: false\r\n")
    #expect(write.touchesSettings)
    #expect(!CameraParameters.settings(applying: write, to: StreamSettings()).adaptiveBitrate)
    #expect(failure("videoEncoder.rateControl.adaptive: sometimes\r\n")?.statusCode == 400)
    #expect(failure("videoEncoder.rateControl.currentBitrate: 1000\r\n")?.statusCode == 458)
  }

  @Test("Zoom is clamped to the mapping on apply, and non-numbers are 400")
  func zoomClamping() throws {
    let write = try set("ptz.zoom: 40\r\n")
    let applied = CameraParameters.snapshot(applying: write, to: Self.snapshot())
    #expect(applied.displayedZoom == 9, "clamped to the recommended ceiling, not the 189x digital one")
    #expect(applied.settings.displayedZoom == 9)

    let small = CameraParameters.snapshot(applying: try set("ptz.zoom: 0.1\r\n"), to: Self.snapshot())
    #expect(small.displayedZoom == 0.5)

    #expect(failure("ptz.zoom: wide\r\n")?.statusCode == 400)
    #expect(failure("ptz.zoom: -1\r\n")?.statusCode == 400)
  }

  @Test("A format must be one the camera offers, merged with the current fields")
  func formats() throws {
    // 1080p60 exists, so changing only the rate is fine.
    let rate = try set("videoEncoder.rateControl.frameRateLimit: 60\r\n")
    #expect(rate.frameRate == 60)

    // 4K60 does not exist.
    let bad = failure("videoEncoder.resolution.width: 3840\r\nvideoEncoder.resolution.height: 2160\r\nvideoEncoder.rateControl.frameRateLimit: 60\r\n")
    #expect(bad?.statusCode == 400)
    #expect(bad?.name == "videoEncoder.rateControl.frameRateLimit")

    // 4K30 does.
    let ok = try set("videoEncoder.resolution.width: 3840\r\nvideoEncoder.resolution.height: 2160\r\n")
    let applied = CameraParameters.settings(applying: ok, to: StreamSettings())
    #expect(applied.width == 3840 && applied.height == 2160 && applied.frameRate == 30)

    // A simulator offers no formats; anything goes there rather than nothing.
    var empty = Self.snapshot()
    empty.formats = []
    let sim = CameraParameters.parseSet(body: "videoEncoder.resolution.width: 640\r\n", snapshot: empty)
    #expect((try? sim.get())?.width == 640)
  }

  @Test("Lenses: unknown ids and the last lens at a position are 400")
  func lenses() throws {
    let write = try set("lens.disabled: uw, tele\r\n")
    #expect(write.disabledLensIDs == [ "uw", "tele" ])
    #expect(failure("lens.disabled: uw,wide,tele\r\n")?.statusCode == 400, "no back lens left")
    #expect(failure("lens.disabled: front\r\n")?.statusCode == 400, "no front lens left")
    #expect(failure("lens.disabled: periscope\r\n")?.statusCode == 400)
    let none = try set("lens.disabled: \r\n")
    #expect(none.disabledLensIDs == [])
  }

  @Test("Position and audio parse, and the echo names only what was written")
  func positionAudioAndEcho() throws {
    let write = try set("videoSource.position: front\r\naudioEncoder.enabled: false\r\ndevice.name:   \r\n")
    #expect(write.position == .front)
    #expect(write.audioEnabled == false)
    #expect(write.touchesSettings)

    let applied = CameraParameters.snapshot(applying: write, to: Self.snapshot())
    #expect(applied.position == .front)
    #expect(applied.settings.audioEnabled == false)
    #expect(applied.name == DeviceIdentity.defaultName(forUUID: applied.cname), "an empty name falls back like the phone")

    let echo = CameraParameters.echo(write, applied: applied)
    #expect(echo.pairs.map(\.name) == [ "videoSource.position", "audioEncoder.enabled", "device.name" ])
    #expect(echo["videoSource.position"] == "front")
    #expect(echo["audioEncoder.enabled"] == "false")

    #expect(failure("videoSource.position: sideways\r\n")?.statusCode == 400)
    #expect(failure("audioEncoder.enabled: maybe\r\n")?.statusCode == 400)
  }

  @Test("Numbers print without trailing zeros")
  func numberFormatting() {
    #expect(CameraParameters.number(1) == "1")
    #expect(CameraParameters.number(0.5) == "0.5")
    #expect(CameraParameters.number(2.75) == "2.75")
    #expect(CameraParameters.number(29.97) == "29.97")
    #expect(CameraParameters.number(1.0004) == "1")
  }

  @Test("The thermal name maps to the pill level the phone draws")
  func thermalLevel() {
    let decoded = CameraParameters.decodeSnapshot(CameraParameters.encode(Self.snapshot()))
    #expect(ThermalBadgeLevel(telemetryName: decoded?.thermalName ?? "") == .fair)
  }
}
