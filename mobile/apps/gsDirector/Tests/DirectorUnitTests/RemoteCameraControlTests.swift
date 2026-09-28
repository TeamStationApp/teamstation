import CameramanCore
import CameramanRemote
import DirectorRTSP
import Foundation
import Testing

/// The remote model against a scripted transport: what it sends, what it shows, and how it
/// behaves when the phone refuses or goes quiet.
@Suite("Remote camera control")
struct RemoteCameraControlTests {
  /// A phone in a box: answers `GET *` from a snapshot it holds, applies writes to it, and records
  /// every body it was sent.
  final class ScriptedTransport: ParameterTransport, @unchecked Sendable {
    private let lock = NSLock()
    var snapshot: CameraSnapshot
    private(set) var gets = 0
    private(set) var sets: [String] = []
    var state: ParameterTransportState = .ready
    /// When set, every request fails with it: the phone has gone quiet.
    var failure: Error?
    /// When set, the next SET answers with this instead of applying.
    var refusal: ParameterReply?

    init(snapshot: CameraSnapshot) { self.snapshot = snapshot }

    func start() {}
    func stop() {}

    func get(_ body: String) async throws -> ParameterReply {
      try lock.withLock {
        if let failure { throw failure }
        gets += 1
        switch CameraParameters.respondToGet(body: body, snapshot: snapshot) {
        case .success(let set): return ParameterReply(statusCode: 200, reasonPhrase: "OK", body: set.encoded)
        case .failure(let error): return ParameterReply(statusCode: error.statusCode, reasonPhrase: error.reasonPhrase, body: error.body)
        }
      }
    }

    func set(_ body: String) async throws -> ParameterReply {
      try lock.withLock {
        if let failure { throw failure }
        sets.append(body)
        if let refusal { self.refusal = nil; return refusal }
        switch CameraParameters.parseSet(body: body, snapshot: snapshot) {
        case .success(let write):
          snapshot = CameraParameters.snapshot(applying: write, to: snapshot)
          return ParameterReply(statusCode: 200, reasonPhrase: "OK", body: CameraParameters.echo(write, applied: snapshot).encoded)
        case .failure(let error):
          return ParameterReply(statusCode: error.statusCode, reasonPhrase: error.reasonPhrase, body: error.body)
        }
      }
    }
  }

  struct Quiet: Error {}

  static func phone() -> CameraSnapshot {
    CameraSnapshot(
      name: "Third Base",
      cname: "c94df9ca-d7c2-468f-8529-97d01fba14e7",
      model: "iPhone14,2",
      thermalName: "serious",
      status: "running",
      battery: BatteryStatus(percent: 42, isCharging: true),
      position: .back,
      deviceType: "AVCaptureDeviceTypeBuiltInTripleCamera",
      mapping: ZoomMapping(minimumDeviceZoom: 1, maximumDeviceZoom: 18, displayMultiplier: 0.5, switchOverDeviceZooms: [ 2, 6 ]),
      deviceZoom: 2,
      settings: StreamSettings(),
      formats: [ FormatCatalogue.Option(width: 1920, height: 1080, frameRate: 30, supportsMultiLensSwitching: true) ],
      lenses: [
        CameraLens(id: "wide", position: .back, deviceType: "w", uniqueDeviceID: "wide", focalLengthMM: 26, displayedZoom: 1, deviceZoom: 2, isSecondaryNative: false),
        CameraLens(id: "front", position: .front, deviceType: "w", uniqueDeviceID: "front", focalLengthMM: nil, displayedZoom: 1, deviceZoom: 1, isSecondaryNative: false)
      ],
      streamURL: "rtsp://192.168.7.118:554/live/mainstream",
      clientCount: 1
    )
  }

  @Test("A poll fills the model with what the phone reports")
  @MainActor
  func pollParsesIntoTheModel() async {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    #expect(!model.hasSnapshot)
    await model.poll()
    #expect(model.hasSnapshot)
    #expect(model.name == "Third Base")
    #expect(model.cname == "c94df9ca-d7c2-468f-8529-97d01fba14e7")
    #expect(model.mapping.presetDisplayedZooms == [ 0.5, 1, 3, 9 ])
    #expect(model.displayedZoom == 1)
    #expect(model.thermalLevel == .warm)
    #expect(model.battery == BatteryStatus(percent: 42, isCharging: true))
    #expect(model.clientCount == 1)
    #expect(model.availableLenses.map(\.id) == [ "wide", "front" ])
    #expect(model.isResponding)
    #expect(!model.animatesChrome)
  }

  @Test("A drag sends only the last zoom, and shows it locally until the phone confirms")
  @MainActor
  func dragCoalescesToTheLastZoom() async {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false, zoomCoalesceInterval: .seconds(30))
    await model.poll()
    for zoom in [ 1.2, 1.5, 2.0, 2.4, 3.0 ] { model.setDisplayedZoom(zoom) }
    #expect(model.displayedZoom == 3, "the rail follows the finger before the write goes out")
    #expect(transport.sets.isEmpty, "nothing sent yet: the coalescing window is open")
    await model.flushZoom()
    #expect(transport.sets == [ "ptz.zoom: 3\r\n" ])
    #expect(transport.snapshot.displayedZoom == 3)

    // A stale poll racing the write must not snap the rail back.
    transport.snapshot.deviceZoom = 2
    await model.poll()
    #expect(model.displayedZoom == 3)
  }

  @Test("A phone without its own software zoom gets Director's 2x on top, in yellow")
  @MainActor
  func directorZoomExtendsAPhoneWithoutSoftwareZoom() async {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(
      transport: transport,
      animatesChrome: false,
      extendsWithDirectorZoom: true,
      zoomCoalesceInterval: .seconds(30)
    )
    var reported: [Double] = []
    model.onDirectorZoom = { reported.append($0) }
    await model.poll()
    #expect(model.mapping.presetDisplayedZooms == [ 0.5, 1, 3, 9, 18 ])
    #expect(model.mapping.isSoftwareSegment(3))

    model.setDisplayedZoom(13.5)
    await model.flushZoom()
    #expect(transport.sets == [ "ptz.zoom: 9\r\n" ], "the phone is driven to its own ceiling")
    #expect(model.directorZoom == 1.5)
    #expect(reported == [ 1.5 ])
    #expect(model.displayedZoom == 13.5)

    // Back inside the phone's range, Director's share goes back to 1.
    model.setDisplayedZoom(3)
    #expect(model.directorZoom == 1)
    #expect(reported == [ 1.5, 1 ])
  }

  @Test("A phone that zooms in software itself is left to do it")
  @MainActor
  func phoneWithSoftwareZoomNeedsNoDirectorZoom() async {
    var phone = Self.phone()
    phone.mapping = ZoomMapping(
      minimumDeviceZoom: 1,
      maximumDeviceZoom: 36,
      displayMultiplier: 0.5,
      switchOverDeviceZooms: [ 2, 6 ],
      softwareZoomStartDeviceZoom: 18
    )
    let transport = ScriptedTransport(snapshot: phone)
    let model = RemoteCameraControl(
      transport: transport,
      animatesChrome: false,
      extendsWithDirectorZoom: true,
      directorZoom: 1.5,
      zoomCoalesceInterval: .seconds(30)
    )
    var reported: [Double] = []
    model.onDirectorZoom = { reported.append($0) }
    await model.poll()
    #expect(model.mapping == phone.mapping)
    #expect(model.directorZoom == 1)
    #expect(reported == [ 1 ], "a zoom left over from before is cleared")

    model.setDisplayedZoom(13.5)
    await model.flushZoom()
    #expect(transport.sets == [ "ptz.zoom: 13.5\r\n" ])
    #expect(model.directorZoom == 1)
  }

  @Test("Zoom is clamped to the phone's mapping and the echo is what the phone applied")
  @MainActor
  func zoomIsClampedAndEchoed() async {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false, zoomCoalesceInterval: .seconds(30))
    await model.poll()
    model.setDisplayedZoom(40)
    #expect(model.displayedZoom == 9)
    await model.flushZoom()
    #expect(transport.sets == [ "ptz.zoom: 9\r\n" ])
    model.setDeviceZoom(4)
    #expect(model.displayedZoom == 2)
  }

  @Test("Done sends only what changed, as one request, and nothing when nothing changed")
  @MainActor
  func applySendsTheDiff() async throws {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    await model.poll()

    model.apply(model.settings)
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.sets.isEmpty, "a visit that changed nothing sends nothing")

    var next = model.settings
    next.setCodec(.h264)
    next.audioEnabled = false
    model.apply(next)
    try await Task.sleep(for: .milliseconds(100))
    #expect(transport.sets == [ "videoEncoder.encoding: H264\r\nvideoEncoder.rateControl.bitrateLimit: 6000\r\nvideoEncoder.rateControl.bitrateFloor: 3000\r\naudioEncoder.enabled: false\r\n" ])
    #expect(transport.snapshot.settings.codec == .h264)
    #expect(model.settings.codec == .h264)
    #expect(model.settings.bitrate == 6_000_000)
    #expect(model.settings.bitrateFloor == 3_000_000)
  }

  @Test("A floor chosen in Settings goes to the phone and is read back from it")
  @MainActor
  func floorRoundTrips() async throws {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    await model.poll()
    #expect(model.settings.bitrateFloor == 2_000_000)

    var next = model.settings
    next.bitrate = 8_000_000
    next.bitrateFloor = 5_000_000
    model.apply(next)
    try await Task.sleep(for: .milliseconds(100))
    #expect(transport.sets == [ "videoEncoder.rateControl.bitrateLimit: 8000\r\nvideoEncoder.rateControl.bitrateFloor: 5000\r\n" ])
    #expect(transport.snapshot.settings.bitrateFloor == 5_000_000)
    #expect(model.settings.bitrateFloor == 5_000_000)

    // A floor changed on the phone itself shows up on the next poll.
    transport.snapshot.settings.bitrateFloor = 1_500_000
    // Past the window in which a local write outranks a poll.
    try await Task.sleep(for: .milliseconds(1_600))
    await model.poll()
    #expect(model.settings.bitrateFloor == 1_500_000)
  }

  /// A phone in a box that predates the floor: it leaves the name out of `GET *` and refuses a
  /// `SET` that names it, as an older Cameraman does.
  final class OlderPhoneTransport: ParameterTransport, @unchecked Sendable {
    let inner: ScriptedTransport
    init(snapshot: CameraSnapshot) { inner = ScriptedTransport(snapshot: snapshot) }
    var state: ParameterTransportState { inner.state }
    func start() {}
    func stop() {}

    func get(_ body: String) async throws -> ParameterReply {
      let reply = try await inner.get(body)
      let kept = reply.body.components(separatedBy: "\r\n").filter { !$0.hasPrefix(CameraParameterName.bitrateFloorKbps) }
      return ParameterReply(statusCode: reply.statusCode, reasonPhrase: reply.reasonPhrase, body: kept.joined(separator: "\r\n"))
    }

    func set(_ body: String) async throws -> ParameterReply {
      if body.contains(CameraParameterName.bitrateFloorKbps) {
        return ParameterReply(statusCode: 451, reasonPhrase: "Parameter Not Understood", body: "\(CameraParameterName.bitrateFloorKbps)\r\nunknown parameter\r\n")
      }
      return try await inner.set(body)
    }
  }

  @Test("A phone that predates the floor is not sent one, so the rest of the change still lands")
  @MainActor
  func olderPhoneIsNotSentTheFloor() async throws {
    let transport = OlderPhoneTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    await model.poll()
    #expect(model.settings.bitrateFloor == 2_000_000, "read as half the rate")

    var next = model.settings
    next.setCodec(.h264)
    next.bitrateFloor = 1_000_000
    model.apply(next)
    try await Task.sleep(for: .milliseconds(100))
    #expect(transport.inner.sets == [ "videoEncoder.encoding: H264\r\nvideoEncoder.rateControl.bitrateLimit: 6000\r\n" ])
    #expect(model.lastError == nil)
    #expect(transport.inner.snapshot.settings.codec == .h264)
  }

  @Test("Flip and rename go immediately and show at once")
  @MainActor
  func flipAndRename() async throws {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    await model.poll()
    model.flip()
    #expect(model.position == .front)
    model.rename(to: "  Left Field ")
    #expect(model.name == "Left Field")
    try await Task.sleep(for: .milliseconds(100))
    #expect(transport.sets == [ "videoSource.position: front\r\n", "device.name:   Left Field \r\n" ])
    #expect(transport.snapshot.position == .front)
    #expect(transport.snapshot.name == "Left Field")
  }

  @Test("A 458 surfaces as lastError without dropping anything")
  @MainActor
  func refusalIsSurfaced() async throws {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    await model.poll()
    transport.refusal = ParameterReply(statusCode: 458, reasonPhrase: "Parameter Is Read-Only", body: "device.cname\r\nread-only parameter\r\n")
    model.rename(to: "x")
    try await Task.sleep(for: .milliseconds(100))
    #expect(model.lastError == "458 Parameter Is Read-Only: device.cname")
    #expect(model.isResponding)
    await model.poll()
    #expect(model.isResponding)
    #expect(model.lastError == nil || model.lastError?.hasPrefix("458") == true)
  }

  @Test("Two missed polls mean the phone is not answering; one answer brings it back")
  @MainActor
  func missedPolls() async {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    await model.poll()
    transport.failure = Quiet()
    await model.poll()
    #expect(model.isResponding, "one miss is a blip")
    await model.poll()
    #expect(!model.isResponding)
    transport.failure = nil
    await model.poll()
    #expect(model.isResponding)
  }

  @Test("previewThermal is a no-op remotely")
  @MainActor
  func previewThermalIsIgnored() async throws {
    let transport = ScriptedTransport(snapshot: Self.phone())
    let model = RemoteCameraControl(transport: transport, animatesChrome: false)
    await model.poll()
    model.previewThermal(.critical)
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.sets.isEmpty)
    #expect(model.thermalLevel == .warm)
  }

  @Test("Settings lines follow the wire's table order with the codec before its rate")
  func settingsLines() {
    var next = StreamSettings()
    next.setCodec(.h264)
    next.bitrate = 2_500_000
    next.disabledLensIDs = [ "b", "a" ]
    let lines = RemoteCameraControl.settingsLines(from: StreamSettings(), to: next)
    #expect(lines.map(\.0) == [
      "videoEncoder.encoding", "videoEncoder.rateControl.bitrateLimit", "videoEncoder.rateControl.bitrateFloor",
      "lens.disabled"
    ])
    #expect(lines.map(\.1) == [ "H264", "2500", "3000", "a,b" ])
    #expect(
      RemoteCameraControl.settingsLines(from: StreamSettings(), to: next, includingFloor: false).map(\.0)
        == [ "videoEncoder.encoding", "videoEncoder.rateControl.bitrateLimit", "lens.disabled" ]
    )
  }

  @Test("Adaptive bitrate goes on the wire right after the rate it adapts")
  func adaptiveBitrateLine() {
    var next = StreamSettings()
    next.bitrate = 8_000_000
    next.adaptiveBitrate = false
    let lines = RemoteCameraControl.settingsLines(from: StreamSettings(), to: next)
    #expect(lines.map(\.0) == [ "videoEncoder.rateControl.bitrateLimit", "videoEncoder.rateControl.adaptive" ])
    #expect(lines.map(\.1) == [ "8000", "false" ])
  }
}
