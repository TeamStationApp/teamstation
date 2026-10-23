import CameramanCore
import CameramanTestHarness
import Darwin
import Foundation
import TeamStationObservability
import XCTest
@testable import CameramanUI

final class ObservabilityTests: XCTestCase {
  actor Capture {
    var events: [[String: Any]] = []
    func send(_ data: Data) -> Int {
      events += String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap {
        (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
      }
      return 202
    }
    func names() -> [String] { events.compactMap { $0["E"] as? String } }
    func errors() -> [String] { events.compactMap { ($0["P"] as? [String: Any])?["ec"] as? String } }
  }

  @MainActor func testRealListenerTransitionsAndBindFailureAreLogged() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = Capture()
    await AppLog.close()
    AppLog.start(app: .cameraman, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("queue"), sender: { await capture.send($0) })
    let environment = AppEnvironment(launch: LaunchConfiguration(arguments: ["-rtspPort", "0", "-advertise", "false", "-persistSettings", "false"]), broadcastStore: InMemorySettingsStore(), eventControlPorts: [])
    environment.setBroadcasting(true)
    for _ in 0..<100 where !environment.serverStatus.isListening { try await Task.sleep(for: .milliseconds(20)) }
    XCTAssertTrue(environment.serverStatus.isListening)
    environment.setBroadcasting(false)
    try await Task.sleep(for: .milliseconds(100))

    let socket = Darwin.socket(AF_INET6, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(socket, 0)
    defer { Darwin.close(socket) }
    var dualStack: Int32 = 0
    XCTAssertEqual(setsockopt(socket, IPPROTO_IPV6, IPV6_V6ONLY, &dualStack, socklen_t(MemoryLayout<Int32>.size)), 0)
    var address = sockaddr_in6()
    address.sin6_family = sa_family_t(AF_INET6)
    address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
    let bound = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
    XCTAssertEqual(bound, 0)
    XCTAssertEqual(listen(socket, 1), 0)
    var length = socklen_t(MemoryLayout<sockaddr_in6>.size)
    let named = withUnsafeMutablePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(socket, $0, &length) } }
    XCTAssertEqual(named, 0)
    let blocked = AppEnvironment(launch: LaunchConfiguration(arguments: ["-rtspPort", String(UInt16(bigEndian: address.sin6_port)), "-advertise", "false", "-persistSettings", "false"]), broadcastStore: InMemorySettingsStore(), eventControlPorts: [])
    XCTAssertEqual(blocked.settings.port, Int(UInt16(bigEndian: address.sin6_port)))
    blocked.setBroadcasting(true)
    for _ in 0..<100 where blocked.serverStatus.lastError == nil { try await Task.sleep(for: .milliseconds(20)) }
    XCTAssertNotNil(blocked.serverStatus.lastError)
    blocked.setBroadcasting(false)
    await AppLog.close()
    let names = await capture.names()
    XCTAssertEqual(names.filter { $0 == "stream_started" }.count, 1)
    XCTAssertEqual(names.filter { $0 == "stream_stopped" }.count, 1)
    XCTAssertTrue(names.contains("stream_failed"))
  }

  @MainActor func testRecordingAndDeniedCaptureLogOnlyClosedEvents() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = Capture()
    await AppLog.close()
    AppLog.start(app: .cameraman, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("queue"), sender: { await capture.send($0) })
    let denied = AppEnvironment(launch: LaunchConfiguration(arguments: ["-persistSettings", "false"]), broadcastStore: InMemorySettingsStore(), eventControlPorts: [], captureHardwareAvailable: true, requestCaptureAccess: { _ in false })
    await denied.start()
    XCTAssertFalse(denied.cameraAuthorized)
    let recording = AppEnvironment(launch: LaunchConfiguration(arguments: ["-syntheticCamera", "true", "-recordSeconds", "0.1", "-persistSettings", "false", "-width", "320", "-height", "180", "-frameRate", "24", "-audioEnabled", "false"]), broadcastStore: InMemorySettingsStore(), eventControlPorts: [], requestCaptureAccess: { _ in true })
    await recording.start()
    XCTAssertEqual(recording.status, "recorded")
    await AppLog.close()
    let names = await capture.names(), errors = await capture.errors()
    XCTAssertTrue(names.contains("recording_started"))
    XCTAssertTrue(names.contains("recording_stopped"))
    XCTAssertTrue(errors.contains("permission"))
  }
}
