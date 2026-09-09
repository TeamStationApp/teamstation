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
    var missing = false
    var lastSweep: Date?
    var foundCount = 0
    var sweepCount: UInt64 = 0
  }

  /// How often the loop re-checks whether a sweep has become worthwhile, while it has nothing to
  /// do. A second is far below any cadence the policy asks for and costs nothing but a boolean.
  private static let idleCheckSeconds: Double = 1

  private let scanner: SubnetScanner
  private let handler: ResultHandler
  private let state = OSAllocatedUnfairLock(initialState: State())
  private let now: @Sendable () -> Double

  public init(
    ports: [Int],
    timeout: TimeInterval = 0.3,
    concurrency: Int = 32,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
    onResult: @escaping ResultHandler
  ) {
    self.scanner = SubnetScanner(ports: ports, timeout: timeout, concurrency: concurrency)
    self.handler = onResult
    self.now = now
  }

  /// What the pipeline currently is: recording or streaming, and whether an enabled camera is
  /// unaccounted for. Cheap to call on every telemetry poll.
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
    Task.detached(priority: .utility) { [weak self] in await self?.loop() }
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

      let result = await scanner.scan()

      let stillRunning = state.withLock { state -> Bool in
        guard state.running else { return false }
        state.lastSweep = Date()
        state.foundCount = result.openHosts.count
        state.sweepCount &+= 1
        return true
      }
      guard stillRunning else { return }

      handler(result)

      // The gap runs from here — the end of the sweep — so a sweep that takes longer than the gap
      // cannot stack the next one on top of it.
      try? await Task.sleep(for: .seconds(gap))
    }
  }
}
