import Foundation

/// The operating screen's broadcast control. Remote models do not conform, so Director and Preview
/// do not draw a record button for a camera they are only watching.
@MainActor
public protocol BroadcastControlling: AnyObject {
  var isBroadcasting: Bool { get }
  func setBroadcasting(_ broadcasting: Bool)
}

/// When the RTSP listener is up.
///
/// An operator launch follows the saved choice, and a camera that has never been told to broadcast
/// stays quiet. A UI test or a loopback probe needs the listener without writing that choice, so the
/// next ordinary launch is still quiet. A recording run writes a file and must not bind the port.
public enum BroadcastPolicy {
  public static let preferenceKey = "co.gamestation.cameraman.broadcasting"

  /// How far the stop slider has to travel before it commits. Matches GS Director.
  public static let slideCommitFraction = 0.8

  public static func shouldListen(
    saved: Bool,
    isUITest: Bool,
    selfTest: Bool,
    recordSeconds: Double
  ) -> Bool {
    if recordSeconds > 0 { return false }
    if isUITest || selfTest { return true }
    return saved
  }

  /// The operator's choice is written. A harness launch is not, even when it is listening.
  public static func shouldPersist(persistSettings: Bool, isUITest: Bool, selfTest: Bool) -> Bool {
    persistSettings && !isUITest && !selfTest
  }

  public static func slideCommits(progress: Double) -> Bool {
    progress >= slideCommitFraction
  }
}

/// The saved broadcast choice, beside the stream settings and not inside them.
public struct BroadcastPreference: Sendable {
  private let store: SettingsStore

  public init(store: SettingsStore) {
    self.store = store
  }

  public func load() -> Bool {
    store.string(forKey: BroadcastPolicy.preferenceKey) == "true"
  }

  public func save(_ broadcasting: Bool) {
    store.setString(broadcasting ? "true" : "false", forKey: BroadcastPolicy.preferenceKey)
  }
}
