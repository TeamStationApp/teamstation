import Foundation
import os

/// Runs address sweeps when `CameraSweepPolicy` says they are worth their broadcasts, and hands
/// the results to whoever asked.
///
/// Shared rather than per-transport for the same reason the policy is: the sweep is one pass over
/// the subnet asking every address about every protocol at once, because ARP resolves per address
/// and splitting it per protocol would double the only cost that matters.
///
/// Participants (`SweepParticipant`) add their own ports to that one pass. Their ports are read
/// before every batch of addresses, left out while the app is recording or streaming (also judged
/// per batch), and every answer is routed by port: the cameras' handler sees only camera ports,
/// each participant only its own. A host that answered only on a participant's port is not a
/// camera, so it is neither remembered nor counted here.
///
/// A participant that starts wanting its ports part-way through a sweep (event control turned on)
/// is served by that sweep: the addresses still to come are asked its ports, and the scanner goes
/// back over the ones already passed before the sweep ends (`SubnetScanner.scan(priority:portsNow:)`).
/// A sweep asked for while one runs that began without a participant's ports is therefore
/// answered by the one running, not by another whole sweep after it. One that already carried them
/// from its start is followed at once by another: the addresses it passed were asked before
/// whatever prompted the request (a toggle turned off and on again, a sign-in, a resume), so only a
/// fresh pass looks again.
public final class CameraSweeper: @unchecked Sendable {
  public typealias ResultHandler = @Sendable (SubnetScanner.Result) -> Void
  /// One sweep of the subnets: the addresses to try first, and the ports to ask about, read again
  /// before every batch of addresses.
  public typealias Scan = @Sendable (_ priority: [String], _ ports: @escaping @Sendable () -> [Int]) async
    -> SubnetScanner.Result
  /// The given addresses only, about the given ports.
  public typealias KnownProbe = @Sendable (_ addresses: [String], _ ports: [Int]) async -> SubnetScanner.Result

  private struct State {
    var policy = CameraSweepPolicy()
    var running = false
    var stopped = false
    var isBusy = false
    var isBrowsing = false
    /// Addresses that answered last time, newest first. A camera that dropped is almost always
    /// still where it was, so these are probed before the segment and without pacing.
    var lastSeen: [String] = []
    var missing = false
    /// A sweep asked for outright, run once whatever the policy says: the subnets to sweep changed.
    var sweepRequested = false
    /// Counts `sweepSoon` calls, so a running sweep knows which of them it has taken in.
    var requests: UInt64 = 0
    /// The last request a running sweep read its ports and subnets after.
    var requestsTakenIn: UInt64 = 0
    var lastSweep: Date?
    /// How long the last sweep took, start to finish, catching up included.
    var lastSweepSeconds: Double?
    var foundCount = 0
    var sweepCount: UInt64 = 0
    var knownProbeCount: UInt64 = 0
    /// Sweeps that carried a participant's ports.
    var participantSweepCount: UInt64 = 0
    var participants = SweepParticipantList()
  }

  /// How often the loop re-checks whether a sweep has become worthwhile, while it has nothing to
  /// do. A second is far below any cadence the policy asks for and costs nothing but a boolean.
  private static let idleCheckSeconds: Double = 1

  private let cameraPorts: [Int]
  private let scan: Scan
  private let probeKnownHosts: KnownProbe
  private let handler: ResultHandler
  private let state = OSAllocatedUnfairLock(initialState: State())
  private let now: @Sendable () -> Double
  /// Where the addresses that answered are kept between launches. Nil keeps them in memory only,
  /// which is what every caller had before and what tests want.
  private let persistenceKey: String?

  /// `ports` are the cameras'. Empty makes a sweeper that runs only for its participants.
  public convenience init(
    ports: [Int],
    timeout: TimeInterval = 0.3,
    concurrency: Int = 32,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
    persistenceKey: String? = nil,
    onResult: @escaping ResultHandler
  ) {
    let scanner = SubnetScanner(ports: ports, timeout: timeout, concurrency: concurrency)
    self.init(
      ports: ports,
      now: now,
      persistenceKey: persistenceKey,
      scan: { await scanner.scan(priority: $0, portsNow: $1) },
      probeKnown: { await scanner.probeKnown($0, ports: $1) },
      onResult: onResult
    )
  }

  /// With the sweep itself supplied, for a test that drives sweeps without a network.
  public init(
    ports: [Int],
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
    persistenceKey: String? = nil,
    scan: @escaping Scan,
    probeKnown: @escaping KnownProbe,
    onResult: @escaping ResultHandler
  ) {
    cameraPorts = ports
    self.scan = scan
    probeKnownHosts = probeKnown
    handler = onResult
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

  /// Adds a participant whose ports every following sweep includes while it asks for them. Held
  /// weakly: a participant that goes away simply drops out.
  public func addParticipant(_ participant: SweepParticipant) {
    state.withLock { $0.participants.add(participant) }
  }

  /// Sweeps once as soon as the loop next looks, even with every camera accounted for. For when
  /// what a sweep covers has changed, so the last one's answer is stale. Cuts short the wait after
  /// the previous sweep.
  ///
  /// While a sweep is running this is answered by that sweep, which reads its ports and subnets
  /// before every batch and goes back over what it passed; another sweep follows only if the
  /// request came after the running one last looked.
  public func sweepSoon() {
    state.withLock {
      $0.sweepRequested = true
      $0.requests &+= 1
    }
  }

  public func start() {
    let shouldStart = state.withLock { state -> Bool in
      guard !state.running else { return false }
      state.running = true
      state.stopped = false
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
    guard !remembered.isEmpty, !cameraPorts.isEmpty else { return }
    let result = await probeKnownHosts(remembered, cameraPorts)
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
    state.withLock {
      $0.running = false
      $0.stopped = true
    }
  }

  /// For `/dump-state`: whether sweeping is active, how many have run, what the last one found and
  /// how long it took (`took=`), and how long the current dropout has lasted. `extraPorts=` counts
  /// the sweeps that also asked about a participant's ports, and appears once one has.
  public var diagnostic: String {
    let snapshot = state.withLock { $0 }
    let missingFor = snapshot.policy.missingForSeconds(now: now())
    let age = snapshot.lastSweep.map { Int(Date().timeIntervalSince($0)) }
    return "sweeps=\(snapshot.sweepCount) found=\(snapshot.foundCount)"
      + (snapshot.knownProbeCount > 0 ? " known=\(snapshot.knownProbeCount)" : "")
      + (age.map { " lastAgo=\($0)s" } ?? "")
      + (snapshot.lastSweepSeconds.map { " took=\(String(format: "%.1f", $0))s" } ?? "")
      + " busy=\(snapshot.isBusy ? 1 : 0) missing=\(snapshot.missing ? 1 : 0)"
      + (missingFor.map { " missingFor=\(Int($0))s" } ?? "")
      + (snapshot.participantSweepCount > 0 ? " extraPorts=\(snapshot.participantSweepCount)" : "")
  }

  /// How many sweeps have run.
  public var sweepCount: UInt64 { state.withLock { $0.sweepCount } }

  /// The participants still here, with the ports each asks for now.
  private func participantPorts() -> [(SweepParticipant, [Int])] {
    let held = state.withLock { $0.participants.current() }
    return held.map { ($0, $0.extraSweepPorts) }
  }

  /// The ports a batch asks about now: the cameras' and, unless the app is busy now, every
  /// participant's. Taking them in also takes in every sweep request made so far. None once the
  /// sweeper is stopped, which ends a sweep still running at its next batch rather than letting it
  /// finish a whole pass nobody wants.
  private func portsNow() -> [Int] {
    let extra = participantPorts().flatMap(\.1)
    return state.withLock { state in
      guard !state.stopped else { return [] }
      state.requestsTakenIn = state.requests
      return CameraSweepPolicy.sweepPorts(camera: cameraPorts, extra: extra, isBusy: state.isBusy)
    }
  }

  /// One sweep, now: the cameras' ports and, unless the app is busy, every participant's, as they
  /// are before each batch; then each answer to whoever asked about its port. Nothing is swept when
  /// there is no port to ask about. The loop runs this whenever the policy wants a sweep; a test
  /// runs it directly.
  public func runSweep() async {
    let atStart = participantPorts()
    let priority = state.withLock { $0.lastSeen }
    let ports = portsNow()
    guard !ports.isEmpty else { return }
    // Whether a request made while this runs can be answered by it: only when it began with the
    // cameras' ports alone, so the participant's ports it picks up part-way are caught up on every
    // address it had passed.
    let canAnswerRequests = Set(ports).subtracting(cameraPorts).isEmpty

    let started = ContinuousClock.now
    let result = await scan(priority, { [weak self] in self?.portsNow() ?? [] })
    let took = ContinuousClock.now - started
    let asked = result.askedPorts.isEmpty ? Set(ports) : result.askedPorts
    let carriedExtra = !asked.subtracting(cameraPorts).isEmpty
    let cameras = result.restricted(to: Set(cameraPorts))

    let stillRunning = state.withLock { state -> Bool in
      guard !state.stopped else { return false }
      state.lastSweep = Date()
      state.lastSweepSeconds = Double(took.components.seconds) + Double(took.components.attoseconds) / 1e18
      // Kept for the next sweep's head start. Only cameras that answered, so a segment that has
      // never held a camera never grows this, and a host that answered only a participant's port
      // never reads as a camera.
      if !cameras.openHosts.isEmpty { state.lastSeen = cameras.openHosts }
      state.foundCount = cameras.openHosts.count
      state.sweepCount &+= 1
      if carriedExtra { state.participantSweepCount &+= 1 }
      // Every request made before the sweep last read its ports has been answered by it.
      if canAnswerRequests, state.requestsTakenIn == state.requests { state.sweepRequested = false }
      return true
    }
    guard stillRunning else { return }

    if !cameras.openHosts.isEmpty { remember(cameras.openHosts) }
    if !cameraPorts.isEmpty { handler(cameras) }
    // Whoever asked at any point in the sweep, including a participant that joined part-way.
    var routed: [ObjectIdentifier: (SweepParticipant, Set<Int>)] = [:]
    for (participant, wanted) in atStart + participantPorts() {
      let id = ObjectIdentifier(participant)
      routed[id] = (participant, (routed[id]?.1 ?? []).union(wanted))
    }
    for (participant, wanted) in routed.values {
      let mine = asked.intersection(wanted)
      guard !mine.isEmpty else { continue }
      participant.acceptSweep(result.restricted(to: mine))
    }
  }

  private func loop() async {
    while true {
      let wantsDiscovery = participantPorts().contains { !$0.1.isEmpty }
      let decision: (running: Bool, gap: Double?) = state.withLock { state in
        guard state.running else { return (false, nil) }
        let gap = state.policy.gapAfterNextSweep(
          isBusy: state.isBusy,
          anyEnabledCameraMissing: state.missing,
          isBrowsing: state.isBrowsing,
          eventControlWantsDiscovery: wantsDiscovery,
          now: now()
        )
        let requested = state.sweepRequested
        state.sweepRequested = false
        return (true, gap ?? (requested ? CameraSweepPolicy.gapSeconds : nil))
      }
      guard decision.running else { return }

      guard let gap = decision.gap else {
        // Recording or streaming with every camera accounted for: nothing to look for, and the
        // broadcasts would be unwelcome. Wait for that to change.
        try? await Task.sleep(for: .seconds(Self.idleCheckSeconds))
        continue
      }

      await runSweep()
      guard state.withLock({ $0.running }) else { return }

      // The gap runs from here — the end of the sweep — so a sweep that takes longer than the gap
      // cannot stack the next one on top of it. A sweep asked for outright ends the wait early.
      await pause(gap)
    }
  }

  /// Waits `seconds`, a second at a time, until then or until a sweep is asked for or the sweeper
  /// stops.
  private func pause(_ seconds: Double) async {
    var left = seconds
    while left > 0 {
      let step = min(Self.idleCheckSeconds, left)
      try? await Task.sleep(for: .seconds(step))
      left -= step
      if state.withLock({ $0.sweepRequested || !$0.running }) { return }
    }
  }
}
