import Foundation
import DirectorCore

public enum SourceKind: String, Sendable, Codable, CaseIterable {
  case synthetic
  case file
  case rtsp

  /// Whether this kind represents real cameras on the network. Drives the HUD's availability
  /// readout and tells the operator that an empty source list means a network problem rather
  /// than a configuration one.
  public var isLive: Bool {
    switch self {
    case .synthetic, .file: false
    case .rtsp: true
    }
  }
}

public struct DiscoveredSource: Hashable, Sendable, Codable, Identifiable {
  public let id: SourceID
  public let kind: SourceKind
  /// Name as advertised by the source, before any operator rename.
  public let advertisedName: String
  /// Opaque payload the concrete discovery needs to build a source (stream URL, fixture path).
  public let address: String?

  public init(id: SourceID, kind: SourceKind, advertisedName: String, address: String? = nil) {
    self.id = id
    self.kind = kind
    self.advertisedName = advertisedName
    self.address = address
  }
}

public typealias DiscoveryChangeHandler = @Sendable ([DiscoveredSource]) -> Void

public protocol SourceDiscovery: AnyObject, Sendable {
  var kind: SourceKind { get }
  var isRunning: Bool { get }
  var currentSources: [DiscoveredSource] { get }
  /// Compact finder/Bonjour status for the HUD and `/dump-state`. Empty for fake sources.
  var diagnostic: String { get }
  /// Bonjour advertisements keyed for identity (`_awx_service._tcp` and `_rtsp._tcp`). Empty for kinds that do not browse.
  var advertisements: [CameraAdvertisement] { get }

  func start(onChange: @escaping DiscoveryChangeHandler)
  func stop()
  func makeSource(for discovered: DiscoveredSource) throws -> FrameSource
  /// Turns the periodic search off while the operator is on air, and on again in the source list.
  ///
  /// Searching for cameras costs nothing worth measuring in the source list and something real
  /// during a game: a network discovery competes with the streams it found for the same radio and
  /// the same CPU. Kinds that publish a fixed list ignore this.
  func setPeriodicSearch(_ enabled: Bool)
  /// Searches once, now, regardless of the periodic setting. How a camera that dropped mid-game is
  /// found again at whatever address it came back on.
  func searchNow()
}

extension SourceDiscovery {
  public var diagnostic: String { "" }
  public var advertisements: [CameraAdvertisement] { [] }
  public func setPeriodicSearch(_ enabled: Bool) {}
  public func searchNow() {}
}

/// Which discovery and source implementations the app wires up. Chosen by launch argument so
/// a Maestro flow can pick deterministic content without touching the network.
public enum SourceProfile: String, Sendable, CaseIterable {
  /// Four generated patterns with burned-in frame numbers.
  case synthetic4
  /// Four fixture files decoded at wall-clock pace, for content-realistic encode tests. Reachable
  /// only by launch argument: the fixtures ship with the test runner, not with the app.
  case file4
  /// Real cameras, found on the network and received over RTSP.
  case rtsp

  /// What the operator's "Simulated cameras" switch selects. An app opened from the home screen
  /// passes no launch argument, so this is also what a normal run uses — which is why off has to
  /// mean real cameras rather than any other non-synthetic profile.
  public static func forSimulatedCameras(_ isOn: Bool) -> SourceProfile {
    isOn ? .synthetic4 : .rtsp
  }
}

/// Discovery that publishes a fixed list. Backs `synthetic4` and `file4`, and stands in for
/// live cameras in unit tests.
public final class FakeDiscovery: SourceDiscovery, @unchecked Sendable {
  public let kind: SourceKind

  private let lock = NSLock()
  private var sources: [DiscoveredSource]
  private var handler: DiscoveryChangeHandler?
  private var running = false
  private let factory: @Sendable (DiscoveredSource) throws -> FrameSource

  public init(
    kind: SourceKind,
    sources: [DiscoveredSource],
    factory: @escaping @Sendable (DiscoveredSource) throws -> FrameSource
  ) {
    self.kind = kind
    self.sources = sources
    self.factory = factory
  }

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  public var currentSources: [DiscoveredSource] {
    lock.lock()
    defer { lock.unlock() }
    return sources
  }

  public func start(onChange: @escaping DiscoveryChangeHandler) {
    lock.lock()
    running = true
    handler = onChange
    let snapshot = sources
    lock.unlock()
    onChange(snapshot)
  }

  public func stop() {
    lock.lock()
    running = false
    handler = nil
    lock.unlock()
  }

  /// Lets a test add or remove sources after start, exercising the UI's live-update path.
  public func publish(_ newSources: [DiscoveredSource]) {
    lock.lock()
    sources = newSources
    let handler = self.handler
    lock.unlock()
    handler?(newSources)
  }

  public func makeSource(for discovered: DiscoveredSource) throws -> FrameSource {
    try factory(discovered)
  }
}
