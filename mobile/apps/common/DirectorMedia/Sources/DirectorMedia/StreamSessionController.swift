import Foundation
import Network
import Observation

/// What a stream session publishes through: `ProgramStreamer`, or a fake in a test.
public protocol StreamPublishing: AnyObject, Sendable {
  var running: Bool { get }
  var metrics: ProgramStreamer.Metrics { get }
  /// Opens an encoder and a publish to `urlString`. `onFailure` is told once when the publish drops
  /// by itself afterwards.
  func start(
    urlString: String,
    settings: StreamSettings,
    onFailure: ProgramStreamer.FailureHandler?
  ) async throws
  func stop()
}

extension ProgramStreamer: StreamPublishing {}

/// Tells the controller when the device's network comes back.
public protocol NetworkPathMonitoring: AnyObject {
  /// Starts watching. `onSatisfied` is called on the main actor each time the path goes from
  /// unusable to usable.
  func start(onSatisfied: @escaping @MainActor () -> Void)
  func cancel()
}

/// `NWPathMonitor`, reporting only the transitions to `satisfied`.
public final class SystemNetworkPathMonitor: NetworkPathMonitoring, @unchecked Sendable {
  private var monitor: NWPathMonitor?
  private let queue = DispatchQueue(label: "app.teamstation.stream.path")

  public init() {}

  public func start(onSatisfied: @escaping @MainActor () -> Void) {
    cancel()
    let monitor = NWPathMonitor()
    // Read and written only on `queue`, where the monitor reports.
    final class Last: @unchecked Sendable { var satisfied: Bool? }
    let last = Last()
    monitor.pathUpdateHandler = { path in
      let satisfied = path.status == .satisfied
      defer { last.satisfied = satisfied }
      // The first report is the state at start, not a change.
      guard satisfied, last.satisfied == false else { return }
      Task { @MainActor in onSatisfied() }
    }
    self.monitor = monitor
    monitor.start(queue: queue)
  }

  public func cancel() {
    monitor?.cancel()
    monitor = nil
  }
}

/// Runs work after a delay, cancellably. Injected so a test can run the redial schedule without
/// waiting for it.
@MainActor
public protocol StreamRetryScheduling: AnyObject {
  func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> any StreamRetryTimer
}

@MainActor
public protocol StreamRetryTimer: AnyObject {
  func cancel()
}

/// `Task.sleep` on the main actor.
@MainActor
public final class TaskRetryScheduler: StreamRetryScheduling {
  public init() {}

  private final class Pending: StreamRetryTimer {
    var task: Task<Void, Never>?
    func cancel() { task?.cancel() }
  }

  public func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> any StreamRetryTimer {
    let pending = Pending()
    pending.task = Task { @MainActor in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      action()
    }
    return pending
  }
}

/// The waits between redials: 3 s, doubling to 30 s, back to 3 s after a session that held for
/// 30 s. Pure, so the schedule is a fixture the Kotlin port shares.
public struct StreamRetrySchedule: Sendable, Equatable {
  public static let firstRetrySeconds: Double = 3
  public static let longestRetrySeconds: Double = 30
  public static let liveResetSeconds: Double = 30

  /// What the next redial waits.
  public private(set) var next = StreamRetrySchedule.firstRetrySeconds

  public init() {}

  /// A host started streaming: the first redial waits the least again.
  public mutating func started() {
    next = Self.firstRetrySeconds
  }

  /// A session dropped after `liveFor` seconds live (nil: it never went live). Answers how long to
  /// wait before the redial, and doubles the wait after it.
  public mutating func dropped(liveFor: Double?) -> Double {
    if let liveFor, liveFor >= Self.liveResetSeconds { next = Self.firstRetrySeconds }
    let wait = next
    next = min(wait * 2, Self.longestRetrySeconds)
    return wait
  }
}

/// Thrown by a host's URL request when the server has ended the stream this device holds (a 410):
/// the controller stops redialling until its host starts streaming again.
public struct StreamEndedError: Error, Equatable, Sendable {
  public let message: String

  public init(message: String = "This camera was ended. Start streaming again to go live.") {
    self.message = message
  }
}

/**
 * Keeps one programme stream on the air for as long as its host wants it there.
 *
 * It asks its host for the address to publish to, opens a `ProgramStreamer` session on it, and puts
 * the stream back when it drops by itself. A drop is not a stop: the send times out whenever the
 * uplink carries less than the programme for longer than the socket allows, and a field's uplink
 * does that.
 *
 * - The first redial waits 3 s, and each one after doubles the wait, to 30 s at most: a squeezed
 *   uplink comes back in seconds, an ingest that is down stays down.
 * - A session that stayed live for 30 s puts the wait back to 3 s, so a stream that drops once an
 *   hour is not redialled at the half-minute it backed off to hours before.
 * - The network coming back (`NWPathMonitor` reporting `satisfied`) redials at once, rather than at
 *   the end of a wait that began while there was no network at all.
 * - A host's URL request that throws `StreamEndedError` (the server's 410: somebody ended this
 *   camera) is terminal. The controller goes to `idle` with `lastError` "ended" and dials nothing
 *   until its host calls `start` again.
 *
 * The first dial of a `start` asks for the address with `.start`; every redial asks with `.redial`,
 * which a host passes on to the server so that an ended stream stays ended.
 */
@MainActor
@Observable
public final class StreamSessionController {
  public enum Phase: String, Sendable, Equatable {
    case idle, connecting, live, retrying
  }

  /// Why the address is being asked for.
  public enum DialReason: String, Sendable, Equatable {
    /// The host started streaming: anything may be handed out, including a fresh stream.
    case start
    /// Putting back a stream that dropped: only the stream already held.
    case redial
  }

  /// What the host does around a session. Every closure runs on the main actor.
  public struct Host {
    /// The address to publish to.
    public var requestURL: @MainActor (DialReason) async throws -> String
    /// The settings the next session opens with.
    public var settings: @MainActor () -> StreamSettings
    /// Words for a dial that failed: the server often knows better than the socket why.
    public var explainDialFailure: @MainActor (Error) async -> String
    /// Words for an address that could not be had.
    public var explainURLFailure: @MainActor (Error) -> String
    /// Whether a failure is worth dialling again after. A URL that cannot be parsed is not.
    public var isRetryable: @MainActor (String) -> Bool
    /// Before every dial, the first included.
    public var willDial: @MainActor (DialReason) -> Void
    /// The session dropped or never opened, with why. Called before the controller decides whether
    /// to dial again.
    public var dropped: @MainActor (String) -> Void
    /// A redial is starting, after its wait.
    public var redialing: @MainActor () -> Void
    /// The controller gave up on a failure it will not retry, while its host still wanted it.
    public var gaveUp: @MainActor (String) -> Void
    /// The server ended the stream (`StreamEndedError`).
    public var ended: @MainActor (String) -> Void

    public init(
      requestURL: @escaping @MainActor (DialReason) async throws -> String,
      settings: @escaping @MainActor () -> StreamSettings,
      explainDialFailure: @escaping @MainActor (Error) async -> String = { $0.localizedDescription },
      explainURLFailure: @escaping @MainActor (Error) -> String = { $0.localizedDescription },
      isRetryable: @escaping @MainActor (String) -> Bool = { _ in true },
      willDial: @escaping @MainActor (DialReason) -> Void = { _ in },
      dropped: @escaping @MainActor (String) -> Void = { _ in },
      redialing: @escaping @MainActor () -> Void = {},
      gaveUp: @escaping @MainActor (String) -> Void = { _ in },
      ended: @escaping @MainActor (String) -> Void = { _ in }
    ) {
      self.requestURL = requestURL
      self.settings = settings
      self.explainDialFailure = explainDialFailure
      self.explainURLFailure = explainURLFailure
      self.isRetryable = isRetryable
      self.willDial = willDial
      self.dropped = dropped
      self.redialing = redialing
      self.gaveUp = gaveUp
      self.ended = ended
    }
  }

  public static let firstRetrySeconds = StreamRetrySchedule.firstRetrySeconds
  public static let longestRetrySeconds = StreamRetrySchedule.longestRetrySeconds
  /// How long a session has to stay live for the next drop to wait only `firstRetrySeconds` again.
  public static let liveResetSeconds = StreamRetrySchedule.liveResetSeconds
  /// `lastError` after the server ended the stream.
  public static let endedError = "ended"

  public private(set) var phase: Phase = .idle
  /// How long until the next redial, while `retrying`.
  public private(set) var retryInSeconds: Double?
  /// Why the last session dropped or failed to open; "ended" after a 410.
  public private(set) var lastError: String?
  /// The publish's own numbers: throughput, packets shed, bytes queued, and the bitrate controller.
  public private(set) var congestion = ProgramStreamer.Metrics()
  /// Whether the host wants the stream on the air.
  public private(set) var wanted = false
  /// What the next redial waits.
  public var nextRetrySeconds: Double { schedule.next }
  private var schedule = StreamRetrySchedule()

  private let publisher: any StreamPublishing
  private let host: Host
  private let scheduler: any StreamRetryScheduling
  private let pathMonitor: (any NetworkPathMonitoring)?
  private let now: @MainActor () -> Double
  private var retryTimer: (any StreamRetryTimer)?
  /// Counts dials, so a drop reported for a session already replaced is not acted on twice.
  private var attempt = 0
  private var liveSince: Double?

  public init(
    publisher: any StreamPublishing,
    host: Host,
    scheduler: (any StreamRetryScheduling)? = nil,
    pathMonitor: (any NetworkPathMonitoring)? = nil,
    now: @escaping @MainActor () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.publisher = publisher
    self.host = host
    self.scheduler = scheduler ?? TaskRetryScheduler()
    self.pathMonitor = pathMonitor
    self.now = now
  }

  /// Puts the stream on the air, and keeps it there until `stop`.
  ///
  /// `reason` is the first dial's. A host putting back a stream that was live when the app stopped
  /// starts with `.redial`, so a relaunch can never re-create a stream that was ended.
  public func start(reason: DialReason = .start) {
    wanted = true
    schedule.started()
    lastError = nil
    cancelRetry()
    pathMonitor?.start { [weak self] in self?.networkRestored() }
    dial(reason)
  }

  /// Takes the stream off the air. A drop reported after this is ignored.
  public func stop() {
    wanted = false
    attempt += 1
    cancelRetry()
    pathMonitor?.cancel()
    liveSince = nil
    phase = .idle
    publisher.stop()
    congestion = ProgramStreamer.Metrics()
  }

  /// Reads the publish's numbers into `congestion`, and returns them.
  @discardableResult
  public func refreshCongestion() -> ProgramStreamer.Metrics {
    congestion = publisher.metrics
    return congestion
  }

  /// The network came back. A redial that is waiting goes now.
  public func networkRestored() {
    guard wanted, phase == .retrying else { return }
    cancelRetry()
    redial()
  }

  private func dial(_ reason: DialReason) {
    attempt += 1
    let mine = attempt
    phase = .connecting
    retryInSeconds = nil
    host.willDial(reason)
    Task { @MainActor [weak self] in
      guard let self else { return }
      let url: String
      do {
        url = try await self.host.requestURL(reason)
      } catch let ended as StreamEndedError {
        guard mine == self.attempt else { return }
        self.end(ended.message)
        return
      } catch {
        guard mine == self.attempt else { return }
        self.handleDrop(self.host.explainURLFailure(error), attempt: mine)
        return
      }
      guard mine == self.attempt, self.wanted else { return }
      do {
        try await self.publisher.start(urlString: url, settings: self.host.settings()) { [weak self] message in
          Task { @MainActor in self?.handleDrop(message, attempt: mine) }
        }
      } catch {
        let message = await self.host.explainDialFailure(error)
        self.handleDrop(message, attempt: mine)
        return
      }
      guard mine == self.attempt else { return }
      self.phase = .live
      self.liveSince = self.now()
      self.lastError = nil
    }
  }

  private func handleDrop(_ message: String, attempt dropped: Int) {
    guard dropped == attempt, phase == .connecting || phase == .live else { return }
    lastError = message
    host.dropped(message)
    publisher.stop()
    congestion = ProgramStreamer.Metrics()
    let liveFor = liveSince.map { now() - $0 }
    liveSince = nil
    guard wanted, host.isRetryable(message) else {
      let wasWanted = wanted
      wanted = false
      phase = .idle
      pathMonitor?.cancel()
      if wasWanted { host.gaveUp(message) }
      return
    }
    // A session that held for long enough was a good one: its wait starts over.
    let delay = schedule.dropped(liveFor: liveFor)
    phase = .retrying
    retryInSeconds = delay
    retryTimer = scheduler.schedule(after: delay) { [weak self] in
      self?.retryTimer = nil
      self?.redial()
    }
  }

  private func redial() {
    guard wanted else { return }
    host.redialing()
    dial(.redial)
  }

  private func end(_ message: String) {
    wanted = false
    cancelRetry()
    pathMonitor?.cancel()
    publisher.stop()
    congestion = ProgramStreamer.Metrics()
    liveSince = nil
    phase = .idle
    lastError = Self.endedError
    host.ended(message)
  }

  private func cancelRetry() {
    retryTimer?.cancel()
    retryTimer = nil
    retryInSeconds = nil
  }
}
