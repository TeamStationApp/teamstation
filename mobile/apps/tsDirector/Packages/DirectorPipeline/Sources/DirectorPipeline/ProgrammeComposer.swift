import CoreMedia
import CoreVideo
import DirectorCore
import Foundation
import os

/// Composes the programme picture on a queue of its own, so the camera on air never waits for it.
///
/// The compositor used to run on the drain thread of the camera on air: whatever it cost, that
/// camera paid for in frames, and the frames it lost were trimmed from its delay line where nothing
/// counted them. Measured on the M4 with a 1080p60 camera, a compose that had grown to 15 ms took
/// the camera's tile from 60 frames a second to 19 while its archive kept all 60. Now the drain hands
/// its picture over and returns; when the compositor falls behind it is the programme that drops a
/// picture, and the programme clock repeats the last one, which is what a programme is for.
///
/// It composes one picture at a time, in order, and passes over any picture that can no longer make
/// its moment. A picture is due on the programme at its capture time plus the live delay, and every
/// millisecond it waits here is one it no longer has. When a camera's drain hands over a burst with
/// time to spare, every picture of it is composed and shown on its own tick; when the compositor is
/// behind, the older pictures run out of time and are dropped, counted, and the newest goes on. A
/// camera's pictures wait apart from every other camera's, so at a cut the camera going off air
/// cannot crowd out the new one's, and its leftovers are passed over rather than counted as lost.
/// Each picture held is one from the converter's pool every camera shares, so each camera keeps at
/// most `waitingLimit` waiting.
public final class ProgrammeComposer: @unchecked Sendable {
  /// One picture for the programme, as the camera on air handed it over.
  public struct Job: @unchecked Sendable {
    public let buffer: CVPixelBuffer
    public let presentationTime: CMTime
    /// When the picture was captured, on the wall clock; nil for a replay's picture.
    public let captureWall: WallClock?
    /// When a replay's picture is due, on the host clock.
    public let dueHost: Double?
    /// The camera that handed it over, so a picture from one that has been cut away from is not shown.
    public let sourceID: SourceID
    /// Which time this camera went on air, as the router counts cuts: a picture from before a cut
    /// away and back is not the camera on air's, whatever its `sourceID`.
    public let generation: UInt64
    fileprivate(set) var sequence: UInt64 = 0
    /// When the camera handed it over, in uptime nanoseconds.
    fileprivate(set) var submittedAt: UInt64 = 0

    public init(
      buffer: CVPixelBuffer,
      presentationTime: CMTime,
      captureWall: WallClock?,
      dueHost: Double?,
      sourceID: SourceID,
      generation: UInt64 = 0
    ) {
      self.buffer = buffer
      self.presentationTime = presentationTime
      self.captureWall = captureWall
      self.dueHost = dueHost
      self.sourceID = sourceID
      self.generation = generation
    }
  }

  /// Starts composing a picture and returns whether it could; the completion then runs once, with
  /// the composed picture or nil when the GPU failed it. `MetalCompositor.compose(program:completion:)`.
  public typealias Compose = (CVPixelBuffer, @escaping @Sendable (CVPixelBuffer?) -> Void) -> Bool

  /// Pictures one camera may have waiting: a drain that wakes late hands over a few at once.
  static let waitingLimit = 4
  /// The test delay's ceiling: a programme slower than five frames a second is no test of anything.
  static let maximumDelayMilliseconds: Double = 200
  /// How long a window the worst compose is kept over, in nanoseconds.
  private static let windowNanoseconds: UInt64 = 1_000_000_000

  private let queue = DispatchQueue(label: "app.teamstation.director.programme-compose", qos: .userInteractive)
  /// Where the test delay is spent, so a delivery on `queue` never waits behind it.
  private let delayQueue = DispatchQueue(label: "app.teamstation.director.programme-compose-delay", qos: .userInteractive)
  private let compose: Compose
  private let isOnAir: (Job) -> Bool
  /// Whether a picture can still make its moment if delivered the given number of seconds from now.
  private let isStillDue: (Job, Double) -> Bool
  /// Whether a picture of the camera a cut is leaving is the only one the programme has for its moment.
  private let fillsGap: (Job) -> Bool
  private let deliver: (Job, CVPixelBuffer) -> Void
  private let onMiss: () -> Void
  private let signposter = OSSignposter(subsystem: "app.teamstation.director", category: "programme")

  private let lock = NSLock()
  /// Pictures handed over and not yet taken, oldest first, per camera.
  private var waiting: [SourceID: [Job]] = [:]
  private var scheduled = false
  private var nextSequence: UInt64 = 0
  private var droppedPictures: UInt64 = 0
  private var skippedPictures: UInt64 = 0
  private var delaySeconds: Double = 0
  private var windowIndex: UInt64 = 0
  private var windowMax: Double = 0
  private var previousWindowMax: Double = 0
  private var millisecondsAverage: Double?
  /// The window of the last compose, so an average with nothing behind it reads zero.
  private var lastSampleWindow: UInt64 = 0
  /// What one compose itself costs, from handing the picture to the compositor to the GPU finishing,
  /// in seconds: with the test delay, how long a picture taken now will take to be delivered.
  private var composeCostSeconds: Double = 0

  /// Only touched on `queue`.
  private var composing = false

  public init(
    compose: @escaping Compose,
    isOnAir: @escaping (Job) -> Bool,
    isStillDue: @escaping (Job, Double) -> Bool = { _, _ in true },
    fillsGap: @escaping (Job) -> Bool = { _ in false },
    deliver: @escaping (Job, CVPixelBuffer) -> Void,
    onMiss: @escaping () -> Void
  ) {
    self.compose = compose
    self.isOnAir = isOnAir
    self.isStillDue = isStillDue
    self.fillsGap = fillsGap
    self.deliver = deliver
    self.onMiss = onMiss
  }

  /// Hands a picture over. Called on the camera's drain thread, so it takes a lock and stores the
  /// picture, and never composes, sleeps or waits. Past `waitingLimit` the camera's oldest waiting
  /// picture goes, and is counted.
  public func submit(_ job: Job) {
    var job = job
    job.submittedAt = DispatchTime.now().uptimeNanoseconds
    lock.lock()
    nextSequence &+= 1
    job.sequence = nextSequence
    var queued = waiting[job.sourceID] ?? []
    // A late picture from an earlier time this camera was on air is not wanted beside the current
    // one's, nor are earlier ones once a current one arrives: a cut away and back is not a loss.
    if let newest = queued.last?.generation, job.generation < newest {
      skippedPictures &+= 1
      lock.unlock()
      return
    }
    let before = queued.count
    queued.removeAll { $0.generation < job.generation }
    skippedPictures &+= UInt64(before - queued.count)
    queued.append(job)
    if queued.count > Self.waitingLimit {
      droppedPictures &+= UInt64(queued.count - Self.waitingLimit)
      queued.removeFirst(queued.count - Self.waitingLimit)
    }
    waiting[job.sourceID] = queued
    let schedule = !scheduled
    scheduled = true
    lock.unlock()
    if schedule { queue.async { [weak self] in self?.run() } }
  }

  /// Programme pictures dropped because the compositor was behind; and how long a picture takes
  /// from being handed over to being delivered, in milliseconds: the worst over the last second or
  /// so, and the running average of recent composes (zero once nothing has composed for a couple of
  /// seconds). Reading does not reset anything, so every reader sees the same.
  public func statistics() -> (dropped: UInt64, millisecondsMax: Double, millisecondsAverage: Double) {
    lock.lock()
    defer { lock.unlock() }
    roll(to: DispatchTime.now().uptimeNanoseconds)
    // Nothing composed for two windows: the programme has stopped, and an average of composes
    // that are over would read as a cost that is not being paid.
    let average = windowIndex > lastSampleWindow + 1 ? 0 : (millisecondsAverage ?? 0)
    return (droppedPictures, max(windowMax, previousWindowMax), average)
  }

  /// A delay added to every compose, for showing on a device that a slow compositor costs the
  /// programme pictures and never the camera's. Zero in normal use.
  public func setComposeDelay(milliseconds: Double) {
    let clamped = milliseconds.isFinite ? min(max(milliseconds, 0), Self.maximumDelayMilliseconds) : 0
    lock.lock()
    delaySeconds = clamped / 1_000
    lock.unlock()
  }

  public var composeDelayMilliseconds: Double {
    lock.lock()
    defer { lock.unlock() }
    return delaySeconds * 1_000
  }

  /// Pictures passed over because their camera was no longer on air. Not a loss, so not telemetry.
  var skipped: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return skippedPictures
  }

  /// Waits until nothing is waiting or composing, judged on the composer's own queue so the last
  /// delivery has run. For tests; never call it on that queue.
  func waitUntilIdle(timeout: TimeInterval = 5) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let idle = queue.sync { () -> Bool in
        lock.lock()
        defer { lock.unlock() }
        return waiting.isEmpty && !scheduled && !composing
      }
      if idle { return true }
      Thread.sleep(forTimeInterval: 0.005)
    }
    return false
  }

  // MARK: - On the queue

  private func run() {
    lock.lock()
    scheduled = false
    lock.unlock()
    while !composing {
      lock.lock()
      let queues = waiting
      let delay = delaySeconds
      let expected = delay + composeCostSeconds
      lock.unlock()
      guard !queues.isEmpty else { return }

      // The camera on program's pictures, and during a handover the time left goes to those of the
      // camera it is taking over from, ahead of it only for a picture the programme has nothing else
      // for; any other camera's are from a camera cut away from. Judged outside the lock: the
      // router's checks take its own.
      let live = queues.filter { _, queued in queued.last.map(isOnAir) ?? false }
      let needed = live.first { _, queued in queued.first.map(fillsGap) ?? false }?.key
      let onAir = needed ?? live.max { ($0.value.last?.generation ?? 0) < ($1.value.last?.generation ?? 0) }?.key
      var chosen: Job?
      if let onAir, let snapshot = queues[onAir] {
        // The oldest picture that can still make its moment. The newest goes regardless: it is the
        // programme's best picture whatever the time.
        // Judged at its delivery, a compose from now, which is when the programme sees it.
        chosen = snapshot.dropLast().first { isStillDue($0, expected) } ?? snapshot.last
      }

      var taken: Job?
      lock.lock()
      // Only what was looked at: a picture handed over since stays for the next pass.
      for (sourceID, snapshot) in queues where live[sourceID] == nil {
        let seen = Set(snapshot.map(\.sequence))
        let before = waiting[sourceID]?.count ?? 0
        waiting[sourceID]?.removeAll { seen.contains($0.sequence) }
        skippedPictures &+= UInt64(before - (waiting[sourceID]?.count ?? 0))
        if waiting[sourceID]?.isEmpty == true { waiting[sourceID] = nil }
      }
      if let onAir, let chosen, var queued = waiting[onAir] {
        if let index = queued.firstIndex(where: { $0.sequence == chosen.sequence }) {
          // Those ahead of it ran out of time waiting: the compositor was behind.
          droppedPictures &+= UInt64(index)
          taken = chosen
          queued.removeFirst(index + 1)
        } else if !queued.isEmpty {
          // Pushed out past the limit meanwhile: the oldest left is the next best.
          taken = queued.removeFirst()
        }
        waiting[onAir] = queued.isEmpty ? nil : queued
      }
      lock.unlock()
      guard let job = taken else { continue }
      composing = true
      if delay > 0 {
        delayQueue.async { [weak self] in
          Thread.sleep(forTimeInterval: delay)
          self?.start(job)
        }
      } else {
        start(job)
      }
    }
  }

  /// Hands one picture to the compositor. On `queue`, or on `delayQueue` once the test delay is spent.
  private func start(_ job: Job) {
    let interval = signposter.beginInterval("compose", id: signposter.makeSignpostID())
    let started = DispatchTime.now().uptimeNanoseconds
    let accepted = compose(job.buffer) { [weak self] composed in
      // Timed as the GPU finishes, from the handover: what decides whether the picture still makes
      // its moment on the programme. And the compose alone, for judging the next picture.
      let finished = DispatchTime.now().uptimeNanoseconds
      let elapsed = finished &- job.submittedAt
      let cost = Double(finished &- started) / 1_000_000_000
      self?.signposter.endInterval("compose", interval)
      self?.queue.async {
        self?.noteCost(seconds: cost)
        self?.finish(job, composed: composed, milliseconds: Double(elapsed) / 1_000_000)
      }
    }
    if !accepted {
      signposter.endInterval("compose", interval)
      queue.async { [weak self] in self?.finish(job, composed: nil, milliseconds: nil) }
    }
  }

  /// One composition back. `composing` clears only after the delivery or miss has run, so an idle
  /// composer has delivered everything it took.
  private func finish(_ job: Job, composed: CVPixelBuffer?, milliseconds: Double?) {
    if let milliseconds { record(milliseconds: milliseconds) }
    if let composed {
      deliver(job, composed)
    } else {
      onMiss()
    }
    composing = false
    run()
  }

  private func noteCost(seconds: Double) {
    lock.lock()
    composeCostSeconds += (seconds - composeCostSeconds) * 0.2
    lock.unlock()
  }

  private func record(milliseconds: Double) {
    lock.lock()
    roll(to: DispatchTime.now().uptimeNanoseconds)
    // After an idle stretch the average starts again from this compose.
    if windowIndex > lastSampleWindow + 1 { millisecondsAverage = nil }
    windowMax = max(windowMax, milliseconds)
    lastSampleWindow = windowIndex
    millisecondsAverage = millisecondsAverage.map { $0 + (milliseconds - $0) * 0.1 } ?? milliseconds
    lock.unlock()
  }

  /// Moves the worst-compose window on to the one `now` falls in. Called with `lock` held.
  private func roll(to now: UInt64) {
    let index = now / Self.windowNanoseconds
    guard index != windowIndex else { return }
    previousWindowMax = index == windowIndex + 1 ? windowMax : 0
    windowMax = 0
    windowIndex = index
  }
}
