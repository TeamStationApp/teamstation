import DirectorCore
@testable import DirectorMedia
import DirectorPipeline
import Foundation
import Testing

/// A publish that opens or refuses on command, and can be dropped from the test.
final class FakePublisher: StreamPublishing, @unchecked Sendable {
  private let lock = NSLock()
  private var failure: ProgramStreamer.FailureHandler?
  private var isRunning = false
  /// Each dial's address, in order.
  private(set) var dialled: [String] = []
  private(set) var stops = 0
  /// The next `start` throws this, once.
  var refuseNext: Error?

  var running: Bool {
    lock.lock()
    defer { lock.unlock() }
    return isRunning
  }

  var metrics: ProgramStreamer.Metrics {
    var metrics = ProgramStreamer.Metrics()
    metrics.megabitsPerSecond = running ? 4 : 0
    metrics.droppedPackets = 2
    metrics.queuedBytes = 1_000
    return metrics
  }

  func start(urlString: String, settings: StreamSettings, onFailure: ProgramStreamer.FailureHandler?) async throws {
    if let refused = open(urlString, onFailure) { throw refused }
  }

  private func open(_ url: String, _ onFailure: ProgramStreamer.FailureHandler?) -> Error? {
    lock.lock()
    defer { lock.unlock() }
    dialled.append(url)
    if let refused = refuseNext {
      refuseNext = nil
      return refused
    }
    failure = onFailure
    isRunning = true
    return nil
  }

  func stop() {
    lock.lock()
    isRunning = false
    stops += 1
    lock.unlock()
  }

  /// The publish drops by itself.
  func drop(_ message: String = "send timed out") {
    lock.lock()
    let handler = failure
    failure = nil
    lock.unlock()
    handler?(message)
  }
}

/// Holds the redials until the test fires them.
@MainActor
final class ManualScheduler: StreamRetryScheduling {
  final class Pending: StreamRetryTimer {
    let seconds: Double
    let action: @MainActor () -> Void
    var cancelled = false
    init(seconds: Double, action: @escaping @MainActor () -> Void) {
      self.seconds = seconds
      self.action = action
    }
    func cancel() { cancelled = true }
  }

  private(set) var scheduled: [Pending] = []

  var waiting: [Pending] { scheduled.filter { !$0.cancelled } }

  func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> any StreamRetryTimer {
    let pending = Pending(seconds: seconds, action: action)
    scheduled.append(pending)
    return pending
  }

  /// Runs the oldest redial still waiting.
  func fire() {
    guard let next = waiting.first else { return }
    next.cancelled = true
    next.action()
  }
}

final class FakePath: NetworkPathMonitoring, @unchecked Sendable {
  private var onSatisfied: (@MainActor () -> Void)?
  private(set) var watching = false

  func start(onSatisfied: @escaping @MainActor () -> Void) {
    self.onSatisfied = onSatisfied
    watching = true
  }

  func cancel() {
    onSatisfied = nil
    watching = false
  }

  @MainActor func satisfy() { onSatisfied?() }
}

@MainActor
final class StreamRig {
  let publisher = FakePublisher()
  let scheduler = ManualScheduler()
  let path = FakePath()
  var now: Double = 0
  /// What the host was asked, in order.
  var reasons: [StreamSessionController.DialReason] = []
  var ended: [String] = []
  var dropped: [String] = []
  var gaveUp: [String] = []
  var redials = 0
  /// What the next address request does: an address, or an error to throw.
  var answer: () throws -> String = { "rtmp://ingest.example.test/live/00000000-0000-4000-8000-000000000001" }
  lazy var controller = StreamSessionController(
    publisher: publisher,
    host: .init(
      requestURL: { [unowned self] reason in
        self.reasons.append(reason)
        return try self.answer()
      },
      settings: {
        StreamSettings(
          codec: .hevc,
          resolution: ProgramResolution(width: 1920, height: 1080),
          frameRate: 30,
          bitrateLow: 500_000,
          bitrateHigh: 4_000_000,
          gopSeconds: 2
        )
      },
      isRetryable: { !$0.contains("stream URL") },
      dropped: { [unowned self] in self.dropped.append($0) },
      redialing: { [unowned self] in self.redials += 1 },
      gaveUp: { [unowned self] in self.gaveUp.append($0) },
      ended: { [unowned self] in self.ended.append($0) }
    ),
    scheduler: scheduler,
    pathMonitor: path,
    now: { [unowned self] in self.now }
  )

  /// Lets the controller's dial task run to where it waits.
  func settle() async {
    for _ in 0 ..< 20 { await Task.yield() }
  }
}

@Suite("Stream session controller", .serialized)
@MainActor
struct StreamSessionControllerTests {
  @Test("Starting dials with .start and goes live")
  func startsLive() async {
    let rig = StreamRig()
    rig.controller.start()
    #expect(rig.controller.phase == .connecting)
    await rig.settle()
    #expect(rig.controller.phase == .live)
    #expect(rig.reasons == [ .start ])
    #expect(rig.publisher.dialled.count == 1)
    #expect(rig.path.watching)
    #expect(rig.controller.refreshCongestion().droppedPackets == 2)
    #expect(rig.controller.congestion.queuedBytes == 1_000)
  }

  @Test("Drops redial with .redial after 3, 6, 12, 24 and 30 s")
  func backsOff() async {
    let rig = StreamRig()
    rig.controller.start()
    await rig.settle()
    var waits: [Double] = []
    for _ in 0 ..< 6 {
      rig.publisher.drop()
      await rig.settle()
      #expect(rig.controller.phase == .retrying)
      waits.append(rig.controller.retryInSeconds ?? -1)
      rig.scheduler.fire()
      await rig.settle()
      #expect(rig.controller.phase == .live)
    }
    #expect(waits == [ 3, 6, 12, 24, 30, 30 ])
    #expect(rig.reasons == [ .start ] + Array(repeating: .redial, count: 6))
    #expect(rig.redials == 6)
    #expect(rig.dropped.count == 6)
    #expect(rig.controller.lastError == nil)
  }

  @Test("A session live for 30 s puts the wait back to 3 s")
  func resetsAfterThirtySecondsLive() async {
    let rig = StreamRig()
    rig.controller.start()
    await rig.settle()
    for _ in 0 ..< 3 {
      rig.publisher.drop()
      await rig.settle()
      rig.scheduler.fire()
      await rig.settle()
    }
    #expect(rig.controller.nextRetrySeconds == 24)
    rig.now += 30
    rig.publisher.drop()
    await rig.settle()
    #expect(rig.controller.retryInSeconds == 3)
    rig.scheduler.fire()
    await rig.settle()
    rig.now += 29
    rig.publisher.drop()
    await rig.settle()
    #expect(rig.controller.retryInSeconds == 6)
  }

  @Test("The network coming back redials at once")
  func redialsWhenThePathReturns() async {
    let rig = StreamRig()
    rig.controller.start()
    await rig.settle()
    rig.publisher.drop()
    await rig.settle()
    #expect(rig.controller.phase == .retrying)
    rig.path.satisfy()
    await rig.settle()
    #expect(rig.controller.phase == .live)
    #expect(rig.reasons == [ .start, .redial ])
    #expect(rig.scheduler.waiting.isEmpty)
    // While live, the path says nothing worth acting on.
    rig.path.satisfy()
    await rig.settle()
    #expect(rig.reasons.count == 2)
  }

  @Test("A 410 stops it at idle with \"ended\" until the host starts again")
  func endedIsTerminal() async {
    let rig = StreamRig()
    rig.controller.start()
    await rig.settle()
    rig.answer = { throw StreamEndedError() }
    rig.publisher.drop()
    await rig.settle()
    rig.scheduler.fire()
    await rig.settle()
    #expect(rig.controller.phase == .idle)
    #expect(rig.controller.lastError == "ended")
    #expect(rig.controller.wanted == false)
    #expect(rig.ended.count == 1)
    #expect(rig.scheduler.waiting.isEmpty)
    #expect(rig.path.watching == false)
    #expect(rig.publisher.dialled.count == 1)
    // Nothing else redials it.
    rig.path.satisfy()
    await rig.settle()
    #expect(rig.reasons == [ .start, .redial ])

    rig.answer = { "rtmp://ingest.example.test/live/00000000-0000-4000-8000-000000000002" }
    rig.controller.start()
    await rig.settle()
    #expect(rig.controller.phase == .live)
    #expect(rig.reasons.last == .start)
    #expect(rig.controller.lastError == nil)
  }

  @Test("A start with .redial asks with .redial")
  func resumedStartRedials() async {
    let rig = StreamRig()
    rig.controller.start(reason: .redial)
    await rig.settle()
    #expect(rig.reasons == [ .redial ])
  }

  @Test("An address that cannot be had retries; one that cannot be parsed gives up")
  func failuresBeforeThePublish() async {
    let rig = StreamRig()
    struct Offline: Error {}
    rig.answer = { throw Offline() }
    rig.controller.start()
    await rig.settle()
    #expect(rig.controller.phase == .retrying)
    #expect(rig.dropped.count == 1)

    rig.answer = { "not a url" }
    rig.publisher.refuseNext = RTMPURLRefusal()
    rig.scheduler.fire()
    await rig.settle()
    #expect(rig.controller.phase == .idle)
    #expect(rig.gaveUp == [ "Invalid stream URL" ])
    #expect(rig.controller.wanted == false)
  }

  @Test("Stopping cancels a waiting redial and ignores a late drop")
  func stopCancels() async {
    let rig = StreamRig()
    rig.controller.start()
    await rig.settle()
    rig.publisher.drop()
    await rig.settle()
    rig.controller.stop()
    #expect(rig.controller.phase == .idle)
    #expect(rig.scheduler.waiting.isEmpty)
    rig.scheduler.fire()
    await rig.settle()
    #expect(rig.reasons == [ .start ])
    #expect(rig.controller.congestion == ProgramStreamer.Metrics())
  }

  @Test("The retry schedule on its own")
  func schedule() {
    var schedule = StreamRetrySchedule()
    #expect([ nil, 1, 2, 3, 4, 5 ].map { schedule.dropped(liveFor: $0) } == [ 3, 6, 12, 24, 30, 30 ])
    #expect(schedule.dropped(liveFor: 30) == 3)
    schedule.started()
    #expect(schedule.next == 3)
  }
}

@Suite("Stream session controller's own timer and network path", .serialized)
@MainActor
struct StreamSessionSystemTests {
  @Test("The task scheduler runs its action after the wait, and not once cancelled")
  func taskScheduler() async throws {
    let scheduler = TaskRetryScheduler()
    var ran: [String] = []
    _ = scheduler.schedule(after: 0.01) { ran.append("first") }
    let cancelled = scheduler.schedule(after: 0.01) { ran.append("cancelled") }
    cancelled.cancel()
    try await Task.sleep(for: .milliseconds(200))
    #expect(ran == [ "first" ])
  }

  @Test("The system path monitor starts and stops")
  func systemMonitor() async throws {
    let monitor = SystemNetworkPathMonitor()
    monitor.start {}
    try await Task.sleep(for: .milliseconds(100))
    monitor.start {}
    monitor.cancel()
    monitor.cancel()
  }

  @Test("A host that leaves out its handlers still stops on an ended stream")
  func defaultHandlers() async {
    let controller = StreamSessionController(
      publisher: FakePublisher(),
      host: .init(
        requestURL: { _ in throw StreamEndedError() },
        settings: { StreamSettings(config: .default) }
      ),
      scheduler: ManualScheduler()
    )
    controller.start()
    for _ in 0 ..< 20 { await Task.yield() }
    #expect(controller.phase == .idle)
    #expect(controller.lastError == "ended")
  }
}

private struct RTMPURLRefusal: Error, LocalizedError {
  var errorDescription: String? { "Invalid stream URL" }
}
