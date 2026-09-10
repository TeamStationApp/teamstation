import Foundation
import os

/// Runs address sweeps when `CameraSweepPolicy` says they are worth their broadcasts, and hands
/// the results to whoever asked.
///
/// Shared rather than per-transport for the same reason the policy is: the sweep is one pass over
/// the subnet asking every address about every protocol at once, because ARP resolves per address
/// and splitting it per protocol would double the only cost that matters.
public final class CameraSweeper: @unchecked Sendable {
  public typealias ResultHandler = @Sendable (SubnetScanner.Result) -> Void

  private struct State {
    var policy = CameraSweepPolicy()
    var running = false
    var isBusy = false
    var isBrowsing = false
    /// Addresses that answered last time, newest first. A camera that dropped is almost always
    /// still where it was, so these are probed before the segment and without pacing.
    var lastSeen: [String] = []
    var missing = false
    var lastSweep: Date?
    var foundCount = 0
    var sweepCount: UInt64 = 0
    var knownProbeCount: UInt64 = 0
  }

  /// How often the loop re-checks whether a sweep has become worthwhile, while it has nothing to
  /// do. A second is far below any cadence the policy asks for and costs nothing but a boolean.
  private static let idleCheckSeconds: Double = 1

  private let scanner: SubnetScanner
  private let handler: ResultHandler
  private let state = OSAllocatedUnfairLock(initialState: State())
  private let now: @Sendable () -> Double
  /// Where the addresses that answered are kept between launches. Nil keeps them in memory only,
  /// which is what every caller had before and what tests want.
  private let persistenceKey: String?

  public init(
    ports: [Int],
    timeout: TimeInterval = 0.3,
    concurrency: Int = 32,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
    persistenceKey: String? = nil,
    onResult: @escaping ResultHandler
  ) {
    self.scanner = SubnetScanner(ports: ports, timeout: timeout, concurrency: concurrency)
    self.handler = onResult
    self.now = now
    self.persistenceKey = persistenceKey
    if let persistenceKey,
       let remembered = UserDefaults.standard.stringArray(forKey: persistenceKey),
       !remembered.isEmpty {
      state.withLock { $0.lastSeen = remembered }
    }
    // Startup grace from here: at launch no camera has been heard from yet, and that is not a
    // dropout worth sweeping the segment for.
    let startedAt = now()
    state.withLock { $0.policy = CameraSweepPolicy(startedAt: startedAt) }
  }

  /// What the pipeline currently is: recording or streaming, and whether an enabled camera is
  /// unaccounted for. Cheap to call on every telemetry poll.
  public func setBrowsing(_ isBrowsing: Bool) {
    state.withLock { $0.isBrowsing = isBrowsing }
  }

  public func setDemand(isBusy: Bool, anyEnabledCameraMissing: Bool) {
    state.withLock {
      $0.isBusy = isBusy
      $0.missing = anyEnabledCameraMissing
    }
  }

  public func start() {
    let shouldStart = state.withLock { state -> Bool in
      guard !state.running else { return false }
      state.running = true
      return true
    }
    guard shouldStart else { return }
    Task.detached(priority: .utility) { [weak self] in await self?.probeRemembered() }
    Task.detached(priority: .utility) { [weak self] in await self?.loop() }
  }

  /// At launch, ask the addresses cameras answered on last time, and nothing else.
  ///
  /// The startup grace keeps launch from sweeping the segment, but on this network the NDI camera
  /// is only ever found by address: the iPad does not hear its mDNS. Without this it appeared a
  /// minute after launch, once the first post-grace sweep had finished. Asking one or two known
  /// hosts directly finds it in about a second, at the cost of a few unicast packets.
  private func probeRemembered() async {
    let remembered = state.withLock { $0.lastSeen }
    guard !remembered.isEmpty else { return }
    let result = await scanner.probeKnown(remembered)
    let stillRunning = state.withLock { state -> Bool in
      guard state.running else { return false }
      state.knownProbeCount &+= 1
      return true
    }
    guard stillRunning, !result.openHosts.isEmpty else { return }
    handler(result)
  }

  private func remember(_ hosts: [String]) {
    guard let persistenceKey else { return }
    UserDefaults.standard.set(hosts, forKey: persistenceKey)
  }

  public func stop() {
    state.withLock { $0.running = false }
  }

  /// For `/dump-state`: whether sweeping is active, how many have run, what the last one found,
  /// and how long the current dropout has lasted.
  public var diagnostic: String {
    let snapshot = state.withLock { $0 }
    let missingFor = snapshot.policy.missingForSeconds(now: now())
    let age = snapshot.lastSweep.map { Int(Date().timeIntervalSince($0)) }
    return "sweeps=\(snapshot.sweepCount) found=\(snapshot.foundCount)"
      + (snapshot.knownProbeCount > 0 ? " known=\(snapshot.knownProbeCount)" : "")
      + (age.map { " lastAgo=\($0)s" } ?? "")
      + " busy=\(snapshot.isBusy ? 1 : 0) missing=\(snapshot.missing ? 1 : 0)"
      + (missingFor.map { " missingFor=\(Int($0))s" } ?? "")
  }

  private func loop() async {
    while true {
      let decision: (running: Bool, gap: Double?) = state.withLock { state in
        guard state.running else { return (false, nil) }
        let gap = state.policy.gapAfterNextSweep(
          isBusy: state.isBusy,
          anyEnabledCameraMissing: state.missing,
          isBrowsing: state.isBrowsing,
          now: now()
        )
        return (true, gap)
      }
      guard decision.running else { return }

      guard let gap = decision.gap else {
        // Recording or streaming with every camera accounted for: nothing to look for, and the
        // broadcasts would be unwelcome. Wait for that to change.
        try? await Task.sleep(for: .seconds(Self.idleCheckSeconds))
        continue
      }

      let priority = state.withLock { $0.lastSeen }
      let result = await scanner.scan(priority: priority)

      let stillRunning = state.withLock { state -> Bool in
        guard state.running else { return false }
        state.lastSweep = Date()
        // Kept for the next sweep's head start. Only what answered, so a segment that has never
        // held a camera never grows this.
        if !result.openHosts.isEmpty { state.lastSeen = result.openHosts }
        state.foundCount = result.openHosts.count
        state.sweepCount &+= 1
        return true
      }
      guard stillRunning else { return }

      if !result.openHosts.isEmpty { remember(result.openHosts) }
      handler(result)

      // The gap runs from here — the end of the sweep — so a sweep that takes longer than the gap
      // cannot stack the next one on top of it.
      try? await Task.sleep(for: .seconds(gap))
    }
  }
}
