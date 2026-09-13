import Foundation
import DirectorCore

/// Several discoveries presented as one, so both live transports can run at the same time.
///
/// Paul's deployment is a mix — NDI converters alongside RTSP phones — and until now the app could
/// only be pointed at one transport at a time. There is no operator switch for this and no mixed
/// profile to choose: both live transports are always on, and the operator picks cameras rather
/// than protocols.
///
/// Merging happens here rather than in the app because the merge is bookkeeping, not policy: each
/// child publishes its own list whenever it changes, this holds the latest of each, and the
/// combined list is what the source list and the five-camera cap see. A child that has never
/// published yet contributes nothing, so one transport being slow to find anything cannot delay
/// the other's cameras from appearing.
public final class CompositeSourceDiscovery: SourceDiscovery, @unchecked Sendable {
  public let children: [SourceDiscovery]

  private let lock = NSLock()
  private var latest: [SourceKind: [DiscoveredSource]] = [:]
  private var handler: DiscoveryChangeHandler?
  /// One sweep for every transport. See `SourceDiscovery.sweepPorts` for why it is shared.
  private var sweeper: CameraSweeper?

  public init(_ children: [SourceDiscovery]) {
    self.children = children
  }

  /// Representative only, and there is nothing useful it could be for a mixed list. Anything that
  /// needs to know what a particular camera speaks reads `DiscoveredSource.kind`; anything asking
  /// about the set reads `kinds`.
  public var kind: SourceKind { children.first?.kind ?? .rtsp }

  public var kinds: [SourceKind] { children.map(\.kind) }

  public var isRunning: Bool { children.contains { $0.isRunning } }

  public var currentSources: [DiscoveredSource] {
    lock.lock()
    defer { lock.unlock() }
    return merged()
  }

  /// Each child's own status, labelled, because "found nothing" needs to say which transport found
  /// nothing — with both always on, an empty list is otherwise unattributable.
  public var diagnostic: String {
    lock.lock()
    let sweeper = self.sweeper
    lock.unlock()
    let perChild = children
      .map { "\($0.kind.rawValue)[\($0.diagnostic)]" }
      .joined(separator: " ")
    guard let sweeper else { return perChild }
    return "\(perChild) \(sweeper.diagnostic)"
  }

  public var advertisements: [CameraAdvertisement] {
    children.flatMap(\.advertisements)
  }

  public var sweepPorts: [Int] {
    var ordered: [Int] = []
    for port in children.flatMap(\.sweepPorts) where !ordered.contains(port) {
      ordered.append(port)
    }
    return ordered
  }

  public func acceptSweep(_ result: SubnetScanner.Result) {
    for child in children { child.acceptSweep(result) }
  }

  /// UserDefaults key for the addresses the last sweep found cameras on. A discovery hint only:
  /// a camera is never identified by its address, and a stale entry costs one failed probe.
  public static let rememberedHostsKey = "discovery.rememberedCameraHosts"

  /// Nothing sweeps on this one's behalf; it is the thing that sweeps.
  public func setSweepIsShared(_ isShared: Bool) {}

  public func start(onChange: @escaping DiscoveryChangeHandler) {
    lock.lock()
    handler = onChange
    lock.unlock()

    for child in children {
      child.setSweepIsShared(!child.sweepPorts.isEmpty)
      let childKind = child.kind
      child.start { [weak self] sources in
        guard let self else { return }
        self.lock.lock()
        self.latest[childKind] = sources
        let combined = self.merged()
        let handler = self.handler
        self.lock.unlock()
        handler?(combined)
      }
    }
    startSweeper()
  }

  private func startSweeper() {
    let ports = sweepPorts
    guard !ports.isEmpty else { return }
    lock.lock()
    guard sweeper == nil else {
      lock.unlock()
      return
    }
    // Remembered across launches so the next launch can ask those cameras directly instead of
    // waiting out the startup grace and a full sweep.
    let sweeper = CameraSweeper(ports: ports, persistenceKey: Self.rememberedHostsKey) { [weak self] result in
      self?.acceptSweep(result)
    }
    self.sweeper = sweeper
    lock.unlock()
    sweeper.start()
  }

  public func stop() {
    lock.lock()
    handler = nil
    latest.removeAll()
    let sweeper = self.sweeper
    self.sweeper = nil
    lock.unlock()
    sweeper?.stop()
    for child in children { child.stop() }
  }

  public func makeSource(for discovered: DiscoveredSource) throws -> FrameSource {
    guard let child = children.first(where: { $0.kind == discovered.kind }) else {
      throw CompositeDiscoveryError.noDiscovery(for: discovered.kind)
    }
    return try child.makeSource(for: discovered)
  }

  public func setPeriodicSearch(_ enabled: Bool) {
    for child in children { child.setPeriodicSearch(enabled) }
  }

  public func searchNow() {
    for child in children { child.searchNow() }
  }

  /// Sweeps the subnet once now rather than when the policy next wants to. For a change to which
  /// subnets are swept: without it the new ones are not looked at until a camera goes missing.
  public func sweepNow() {
    lock.lock()
    let sweeper = self.sweeper
    lock.unlock()
    sweeper?.sweepSoon()
  }

  /// Answered here rather than passed down: the sweep the demand describes is this one.
  public func setSweepDemand(isBusy: Bool, anyEnabledCameraMissing: Bool, isBrowsing: Bool) {
    lock.lock()
    let sweeper = self.sweeper
    lock.unlock()
    sweeper?.setDemand(isBusy: isBusy, anyEnabledCameraMissing: anyEnabledCameraMissing)
    sweeper?.setBrowsing(isBrowsing)
    for child in children {
      child.setSweepDemand(
        isBusy: isBusy,
        anyEnabledCameraMissing: anyEnabledCameraMissing,
        isBrowsing: isBrowsing
      )
    }
  }

  /// Ordered by the children rather than by arrival, so the source list does not reshuffle itself
  /// every time one transport happens to publish before the other.
  private func merged() -> [DiscoveredSource] {
    children.flatMap { latest[$0.kind] ?? [] }
  }
}

public enum CompositeDiscoveryError: Error, CustomStringConvertible {
  case noDiscovery(for: SourceKind)

  public var description: String {
    switch self {
    case let .noDiscovery(kind): "no \(kind.rawValue) discovery is running"
    }
  }
}
