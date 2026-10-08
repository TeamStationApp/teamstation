import Foundation

@testable import EventControl

/// The shared fixtures in `Tests/Fixtures`, which every implementation of the protocol runs.
enum Fixtures {
  static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appending(path: "Fixtures")

  static func json(_ name: String) -> [String: Any] {
    let data = try! Data(contentsOf: directory.appending(path: name))
    return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
  }

  static func hex(_ text: String) -> Data { EventControlBytes.data(hex: text)! }

  /// A key from keys.json by name, as credentials.
  static func credentials(_ name: String) -> EventControlCredentials {
    let vector = (json("keys.json")["vectors"] as! [[String: String]]).first { $0["name"] == name }!
    return try! EventControlCredentials(
      issuer: vector["issuer"]!,
      userId: vector["userId"]!,
      accountTag: vector["accountTag"]!,
      keyId: vector["keyId"]!,
      key: vector["key"]!
    )
  }

  static let one = credentials("one")
  static let two = credentials("two")
  static let rotated = credentials("oneRotated")
  static let otherServer = credentials("oneOtherServer")

  static func instance(_ suffix: String) -> EventControlInstanceID {
    EventControlInstanceID(hex: String(repeating: "0", count: 32 - suffix.count) + suffix)!
  }

  static let assignmentA = try! EventAssignment(
    gameId: "gam_demoA",
    title: "Visitors at Pioneers",
    startAt: Date(timeIntervalSince1970: 1_790_013_600)
  )
  static let assignmentB = try! EventAssignment(
    gameId: "gam_demoB",
    title: "Pioneers at Comets",
    startAt: Date(timeIntervalSince1970: 1_790_040_600)
  )
}

/// A clock a test moves by hand.
final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Date

  init(_ start: Date = Date(timeIntervalSince1970: 1_790_013_600)) {
    current = start
  }

  var now: Date { lock.withLock { current } }

  func advance(_ seconds: TimeInterval) {
    lock.withLock { current = current.addingTimeInterval(seconds) }
  }
}

/// Collects what a receiver or link reports, from any thread.
final class Recorder<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [Value] = []

  func append(_ value: Value) {
    lock.withLock { items.append(value) }
  }

  var all: [Value] { lock.withLock { items } }
  var last: Value? { lock.withLock { items.last } }
}

/// Waits until `condition` holds, polling, or gives up after `seconds`.
func eventually(
  _ seconds: TimeInterval = 5,
  _ condition: @Sendable () async -> Bool
) async -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(10))
  }
  return await condition()
}
