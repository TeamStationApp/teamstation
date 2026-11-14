import Foundation
import Testing
@testable import CameramanCore

@Suite("Camera focus contract")
struct CameraFocusTests {
  let near = FocusPoint(x: 0.2, y: 0.8)!

  @Test func feedbackExpiresIndependentlyAndRetapsRestartIt() {
    let start = Date(timeIntervalSince1970: 100)
    let first = FocusFeedback(x: 10, y: 20, started: start)
    let second = FocusFeedback(x: 30, y: 40, started: start.addingTimeInterval(1))
    #expect(first.token != second.token)
    #expect(second.x == 30 && second.y == 40)
    #expect(first.opacity(at: start.addingTimeInterval(-0.1)) == 0)
    #expect(first.opacity(at: start) == 1)
    #expect(abs(first.opacity(at: start.addingTimeInterval(0.25)) - 0.35) < 0.001)
    #expect(first.opacity(at: start.addingTimeInterval(2)) == 0)
    #expect(second.opacity(at: start.addingTimeInterval(2)) == 1)
    #expect(second.opacity(at: start.addingTimeInterval(3)) == 0)
  }

  @Test func validatesCommands() throws {
    for point in [nil, near] {
      let command = try #require(FocusCommand(generation: "camera-1", token: "tap_1", point: point))
      #expect(FocusCommand(text: command.text) == command)
    }
    for bad in ["", "point:a:b:0", "point:a:b:0:1:2", "auto:a:b:1:1", "point:a:b:nan:1",
                "point:a:b:0:inf", "point:a:b:-0.1:1", "point:a:b:0:1.1", "point:a:b:x:0", "point:a:b:0:x",
                "auto::b", "auto:a:", "auto:a:b c", "auto:a:b\n", "auto:é:b", "scan:a:b",
                "auto:a:" + String(repeating: "x", count: 65)] {
      #expect(FocusCommand(text: bad) == nil, "accepted \(bad)")
    }
    #expect(FocusPoint(x: .nan, y: 0) == nil)
    #expect(FocusPoint(x: 0, y: -.infinity) == nil)
  }

  @Test func onlyCurrentScanCanComplete() throws {
    var focus = CameraFocus()
    focus.reset(supported: true, generation: "camera-1")
    let first = try #require(FocusCommand(generation: "camera-1", token: "one", point: near))
    let next = try #require(FocusCommand(generation: "camera-1", token: "two", point: near))
    #expect({ focus.begin(first) }())
    #expect(focus.phase == .focusing)
    #expect({ !focus.begin(first) }())
    #expect({ focus.begin(next) }())
    #expect({ !focus.complete(first, success: true) }())
    #expect({ focus.complete(next, success: false) }())
    #expect(focus.phase == .failed)
    #expect({ !focus.complete(next, success: true) }())
    let auto = try #require(FocusCommand(generation: "camera-1", token: "auto", point: nil))
    #expect({ focus.begin(auto) }())
    #expect(focus.phase == .auto)
    #expect(focus.point == nil)
    #expect({ focus.begin(first) }())
    #expect({ focus.complete(first, success: true) }())
    #expect(focus.phase == .locked)
    focus.reset(supported: true, generation: "camera-2")
    #expect(focus.phase == .reset)
    #expect({ !focus.begin(next) }())
    #expect({ !focus.complete(first, success: true) }())
    focus.reset(supported: false, generation: "camera-1")
    #expect({ !focus.begin(next) }())
    #expect(focus.phase == .unsupported)
    focus.reset(supported: false)
    #expect(!focus.generation.isEmpty)
    for phase in [FocusPhase.auto, .focusing, .locked, .failed, .unsupported, .reset] {
      #expect(!phase.label.isEmpty)
    }
  }

  @Test func mapsVisibleContentAndRejectsBars() {
    func map(_ x: Double, _ y: Double, fill: Bool = false, mirror: Bool = false, zoom: Double = 1) -> FocusPoint? {
      FocusGeometry.imagePoint(x: x, y: y, width: 200, height: 200, imageWidth: 200, imageHeight: 100,
                               fill: fill, mirrored: mirror, receiverZoom: zoom)
    }
    #expect(map(0, 50) == FocusPoint(x: 0, y: 0))
    #expect(map(200, 150) == FocusPoint(x: 1, y: 1))
    #expect(map(100, 49) == nil)
    #expect(map(100, 151) == nil)
    #expect(map(-1, 50) == nil)
    #expect(map(201, 50) == nil)
    #expect(map(0, 0, fill: true) == FocusPoint(x: 0.25, y: 0))
    #expect(map(0, 50, mirror: true) == FocusPoint(x: 1, y: 0))
    #expect(map(0, 50, zoom: 2) == FocusPoint(x: 0.25, y: 0.25))
    #expect(map(0, 50, zoom: 0) == nil)
    #expect(map(.nan, 50) == nil)
    #expect(FocusGeometry.imagePoint(x: 0, y: 0, width: 0, height: 1, imageWidth: 1, imageHeight: 1) == nil)
    #expect(FocusGeometry.imagePoint(x: 0, y: 0, width: 1, height: 0, imageWidth: 1, imageHeight: 1) == nil)
    #expect(FocusGeometry.imagePoint(x: 0, y: 0, width: 1, height: 1, imageWidth: 0, imageHeight: 1) == nil)
    #expect(FocusGeometry.imagePoint(x: 0, y: 0, width: 1, height: 1, imageWidth: 1, imageHeight: 0) == nil)
    let corner = FocusPoint(x: 0, y: 1)!
    #expect(FocusGeometry.unrotated(corner, rotation: 0, mirrored: false) == corner)
    #expect(FocusGeometry.unrotated(corner, rotation: 90, mirrored: false) == FocusPoint(x: 1, y: 1))
    #expect(FocusGeometry.unrotated(corner, rotation: 180, mirrored: false) == FocusPoint(x: 1, y: 0))
    #expect(FocusGeometry.unrotated(corner, rotation: -90, mirrored: false) == FocusPoint(x: 0, y: 0))
    #expect(FocusGeometry.unrotated(corner, rotation: 0, mirrored: true) == FocusPoint(x: 1, y: 1))
    #expect(FocusGeometry.unrotated(corner, rotation: 45, mirrored: false) == nil)
  }

  @Test func wireRoundTripAndCompatibility() throws {
    var snapshot = CameraSnapshot(name: "Camera", cname: "camera", model: "test", thermalName: "nominal",
      status: "running", position: .back, deviceType: "wide", mapping: ZoomMapping(maximumDeviceZoom: 2),
      deviceZoom: 1, settings: .default, formats: [], lenses: [], streamURL: "rtsp://camera.example.test/live", clientCount: 0)
    snapshot.focus.reset(supported: true, generation: "generation")
    let command = try #require(FocusCommand(generation: "generation", token: "tap", point: near))
    #expect({ snapshot.focus.begin(command) }())
    #expect({ snapshot.focus.complete(command, success: true) }())
    let encoded = CameraParameters.encode(snapshot)
    #expect(CameraParameters.decodeSnapshot(encoded)?.focus == snapshot.focus)
    let write = try CameraParameters.parseSet(body: "focus.command: \(command.text)", snapshot: snapshot).get()
    #expect(write.focus == command)
    #expect(!write.isEmpty)
    #expect(!write.touchesSettings)
    #expect(CameraParameters.echo(write, applied: snapshot)["focus.command"] == command.text)
    #expect(CameraParameters.snapshot(applying: write, to: snapshot).focus == snapshot.focus)
    for body in ["focus.state: locked", "focus.command: point:old:tap:0:1",
                 "focus.command: nonsense", "focus.command: \(command.text)\nptz.zoom: 1",
                 "focus.command: \(command.text)\nfocus.command: \(command.text)"] {
      if case .success = CameraParameters.parseSet(body: body, snapshot: snapshot) { Issue.record("accepted \(body)") }
    }
    var failedAuto = snapshot
    failedAuto.focus.point = nil
    failedAuto.focus.phase = .failed
    #expect(CameraParameters.decodeSnapshot(CameraParameters.encode(failedAuto))?.focus == failedAuto.focus)
    snapshot.focus.supported = false
    if case .success = CameraParameters.parseSet(body: "focus.command: \(command.text)", snapshot: snapshot) {
      Issue.record("accepted unsupported focus")
    }
    var old = CameraParameterSet(encoded.pairs.filter { !$0.name.hasPrefix("focus.") })
    #expect(CameraParameters.decodeSnapshot(old)?.focus == CameraFocus())
    old.set("focus.supported", "true")
    #expect(CameraParameters.decodeSnapshot(old)?.focus == CameraFocus())
    for (key, value) in [("focus.state", "mystery"), ("focus.generation", ""), ("focus.rotation", "45"),
                         ("focus.mirrored", "maybe"), ("focus.x", "NaN"), ("focus.request", "bad token")] {
      var malformed = encoded
      malformed.set(key, value)
      #expect(CameraParameters.decodeSnapshot(malformed)?.focus == CameraFocus())
    }
    #expect(try CameraParameters.respondToGet(body: "focus.state", snapshot: snapshot).get()["focus.state"] == "locked")
  }
}
