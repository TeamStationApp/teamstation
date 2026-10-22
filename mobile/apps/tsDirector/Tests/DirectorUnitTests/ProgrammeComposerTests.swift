import CoreMedia
import CoreVideo
import DirectorCore
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// The programme is composed on a queue of its own: the camera on air hands its picture over and
/// returns, and a compositor that falls behind costs the programme pictures, counted, never the
/// camera's frames.
@Suite("Programme composer", .serialized)
struct ProgrammeComposerTests {
  private static let cameraA = SourceID("camera-a")
  private static let cameraB = SourceID("camera-b")

  /// What the composer handed on, from whichever thread it ran on.
  private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var delivered: [(sourceID: SourceID, sequence: UInt64)] = []
    private var missCount = 0
    private var parked: [@Sendable (CVPixelBuffer?) -> Void] = []
    private var parkedBuffers: [CVPixelBuffer] = []
    private var onAir: Set<SourceID> = [ProgrammeComposerTests.cameraA, ProgrammeComposerTests.cameraB]

    func deliver(_ job: ProgrammeComposer.Job) {
      lock.lock()
      delivered.append((job.sourceID, job.sequence))
      lock.unlock()
    }

    func miss() {
      lock.lock()
      missCount += 1
      lock.unlock()
    }

    func park(_ buffer: CVPixelBuffer, _ completion: @escaping @Sendable (CVPixelBuffer?) -> Void) {
      lock.lock()
      parked.append(completion)
      parkedBuffers.append(buffer)
      lock.unlock()
    }

    /// Completes every composition the GPU is "still working on", in order.
    func releaseParked() {
      lock.lock()
      let completions = parked
      let buffers = parkedBuffers
      parked = []
      parkedBuffers = []
      lock.unlock()
      for (completion, buffer) in zip(completions, buffers) { completion(buffer) }
    }

    func setOnAir(_ ids: Set<SourceID>) {
      lock.lock()
      onAir = ids
      lock.unlock()
    }

    func isOnAir(_ id: SourceID) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return onAir.contains(id)
    }

    var deliveries: [(sourceID: SourceID, sequence: UInt64)] {
      lock.lock()
      defer { lock.unlock() }
      return delivered
    }

    var misses: Int {
      lock.lock()
      defer { lock.unlock() }
      return missCount
    }

    var parkedCount: Int {
      lock.lock()
      defer { lock.unlock() }
      return parked.count
    }
  }

  private func makeComposer(
    log: Log,
    isStillDue: @escaping (ProgrammeComposer.Job, Double) -> Bool = { _, _ in true },
    compose: @escaping ProgrammeComposer.Compose
  ) -> ProgrammeComposer {
    ProgrammeComposer(
      compose: compose,
      isOnAir: { log.isOnAir($0.sourceID) },
      isStillDue: isStillDue,
      deliver: { job, _ in log.deliver(job) },
      onMiss: { log.miss() }
    )
  }

  private func job(
    _ buffer: CVPixelBuffer,
    from sourceID: SourceID = cameraA,
    index: Int = 0,
    generation: UInt64 = 0
  ) -> ProgrammeComposer.Job {
    ProgrammeComposer.Job(
      buffer: buffer,
      presentationTime: CMTime(value: CMTimeValue(index), timescale: 60),
      captureWall: WallClock(seconds: Double(index) / 60),
      dueHost: nil,
      sourceID: sourceID,
      generation: generation
    )
  }

  private func waitFor(_ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline {
      if condition() { return true }
      Thread.sleep(forTimeInterval: 0.002)
    }
    return condition()
  }

  private func picture() throws -> CVPixelBuffer {
    let factory = try #require(PixelBufferFactory(width: 64, height: 36, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
    return try #require(factory.makeBuffer())
  }

  @Test("With a 20 ms compose, 60 handovers a second each return at once, and the drops are counted")
  func handoverNeverWaits() throws {
    let log = Log()
    // A picture handed over more than 40 ms ago has missed its moment, as the router would judge it.
    let composer = makeComposer(log: log, isStillDue: { job, deliveredIn in
      Double(DispatchTime.now().uptimeNanoseconds &- job.submittedAt) / 1_000_000_000 + deliveredIn < 0.04
    }) { buffer, completion in
      Thread.sleep(forTimeInterval: 0.02)
      completion(buffer)
      return true
    }
    let buffer = try picture()
    let clock = ContinuousClock()
    var spent: [Duration] = []
    let submitted = 120
    for index in 0 ..< submitted {
      spent.append(clock.measure { composer.submit(job(buffer, index: index)) })
      Thread.sleep(forTimeInterval: 1.0 / 60)
    }
    #expect(composer.waitUntilIdle())
    // Measured against the 20 ms compose, which a handover that waited for it could not beat.
    let sorted = spent.sorted()
    #expect(sorted.last! < .milliseconds(10), "the slowest handover took \(sorted.last!)")
    #expect(sorted[sorted.count / 2] < .milliseconds(2), "the median handover took \(sorted[sorted.count / 2])")

    let statistics = composer.statistics()
    let deliveries = log.deliveries
    #expect(statistics.dropped > 0, "a compositor slower than the camera drops programme pictures")
    #expect(UInt64(deliveries.count) + statistics.dropped == UInt64(submitted))
    #expect(composer.skipped == 0)
    let sequences = deliveries.map(\.sequence)
    #expect(sequences == sequences.sorted() && Set(sequences).count == sequences.count, "delivered in order")
    #expect(sequences.last == UInt64(submitted), "the newest picture is never the one dropped")
    #expect(statistics.millisecondsMax < 100, "a picture waits behind one compose at most: \(statistics.millisecondsMax) ms")
  }

  @Test("A stalled GPU holds one composition and four waiting pictures, and drops the oldest past them")
  func boundedUnderAStall() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    let buffer = try picture()
    composer.submit(job(buffer, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    for index in 1 ..< 10 { composer.submit(job(buffer, index: index)) }
    Thread.sleep(forTimeInterval: 0.1)
    #expect(log.parkedCount == 1, "one composition at a time")
    #expect(composer.statistics().dropped == 5, "ten handed over: one composing, four waiting, five dropped")

    for _ in 0 ..< 5 {
      log.releaseParked()
      _ = waitFor { log.parkedCount == 1 || log.deliveries.count == 5 }
    }
    #expect(composer.waitUntilIdle())
    #expect(log.deliveries.map(\.sequence) == [1, 7, 8, 9, 10], "the four newest, in order")
  }

  @Test("A burst handed over while one picture composes is composed in full, in order")
  func burstIsComposedInFull() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    let buffer = try picture()
    composer.submit(job(buffer, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    // A drain that woke late hands over four pictures at once.
    for index in 1 ... 4 { composer.submit(job(buffer, index: index)) }
    for _ in 0 ..< 5 {
      log.releaseParked()
      _ = waitFor { log.parkedCount == 1 || log.deliveries.count == 5 }
    }
    #expect(composer.waitUntilIdle())
    #expect(log.deliveries.map(\.sequence) == [1, 2, 3, 4, 5])
    #expect(composer.statistics().dropped == 0)
  }

  @Test("Pictures that ran out of time while waiting are dropped, counted, and the next still due goes")
  func latePicturesArePassedOver() throws {
    let log = Log()
    let late: Set<UInt64> = [2, 3]
    let composer = makeComposer(log: log, isStillDue: { job, _ in !late.contains(job.sequence) }) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    let buffer = try picture()
    composer.submit(job(buffer, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    for index in 1 ... 3 { composer.submit(job(buffer, index: index)) }
    for _ in 0 ..< 3 {
      log.releaseParked()
      _ = waitFor { log.parkedCount == 1 || log.deliveries.count == 2 }
    }
    #expect(composer.waitUntilIdle())
    #expect(log.deliveries.map(\.sequence) == [1, 4])
    #expect(composer.statistics().dropped == 2)
  }

  @Test("A picture the compositor refuses, or the GPU fails, is a miss and is not delivered")
  func missesAreCounted() throws {
    let buffer = try picture()
    let refusing = Log()
    let refuser = makeComposer(log: refusing) { _, _ in false }
    for index in 0 ..< 3 {
      refuser.submit(job(buffer, index: index))
      #expect(refuser.waitUntilIdle())
    }
    #expect(refusing.misses == 3)
    #expect(refusing.deliveries.isEmpty)

    let failing = Log()
    let failer = makeComposer(log: failing) { _, completion in
      completion(nil)
      return true
    }
    failer.submit(job(buffer))
    #expect(failer.waitUntilIdle())
    #expect(failing.misses == 1)
    #expect(failing.deliveries.isEmpty)
    #expect(failer.statistics().dropped == 0)
  }

  @Test("After a cut, the camera cut away from's waiting picture is passed over, not composed")
  func cutAwayPicturesAreSkipped() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    let buffer = try picture()
    composer.submit(job(buffer, from: Self.cameraB, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    composer.submit(job(buffer, from: Self.cameraA, index: 1))

    log.setOnAir([Self.cameraB])
    log.releaseParked()
    #expect(composer.waitUntilIdle())
    #expect(log.deliveries.map(\.sourceID) == [Self.cameraB])
    #expect(composer.skipped == 1)
    #expect(composer.statistics().dropped == 0, "a cut is not a loss")
  }

  @Test("A waiting picture is judged at its delivery: the test delay and the compose's own cost ahead")
  func judgedAtDelivery() throws {
    let log = Log()
    let seen = Expected()
    let composer = makeComposer(log: log, isStillDue: { _, deliveredIn in
      seen.add(deliveredIn)
      return true
    }) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    composer.setComposeDelay(milliseconds: 30)
    let buffer = try picture()
    composer.submit(job(buffer, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    composer.submit(job(buffer, index: 1))
    composer.submit(job(buffer, index: 2))
    log.releaseParked()
    #expect(waitFor { log.parkedCount == 1 })
    log.releaseParked()
    #expect(waitFor { log.parkedCount == 1 })
    log.releaseParked()
    #expect(composer.waitUntilIdle())
    #expect(!seen.values.isEmpty)
    #expect(seen.values.allSatisfy { $0 >= 0.03 }, "judged without the delay ahead: \(seen.values)")
  }

  @Test("A cut is never counted as a drop, and the camera cut away from cannot crowd out the new one")
  func cutsAreNotDrops() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    let buffer = try picture()
    log.setOnAir([Self.cameraA])
    composer.submit(job(buffer, from: Self.cameraA, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    composer.submit(job(buffer, from: Self.cameraA, index: 1))
    // The cut, while A's picture composes and another of A's waits.
    log.setOnAir([Self.cameraB])
    composer.submit(job(buffer, from: Self.cameraB, index: 2))
    // The camera cut away from, handing over one last picture after the new camera has.
    composer.submit(job(buffer, from: Self.cameraA, index: 3))

    log.releaseParked()
    #expect(waitFor { log.parkedCount == 1 }, "the new camera's picture goes to the GPU")
    log.releaseParked()
    #expect(composer.waitUntilIdle())
    #expect(log.deliveries.map(\.sourceID) == [Self.cameraA, Self.cameraB], "the composition under way, then the new camera")
    #expect(composer.statistics().dropped == 0, "the cut added no drop")
    #expect(composer.skipped == 2, "A's two waiting pictures were passed over")
  }

  @Test("A picture from before a cut away and back replaces nothing as a drop")
  func olderGenerationIsNotADrop() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    let buffer = try picture()
    composer.submit(job(buffer, from: Self.cameraB, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    composer.submit(job(buffer, from: Self.cameraA, index: 1, generation: 1))
    composer.submit(job(buffer, from: Self.cameraA, index: 2, generation: 3))
    #expect(composer.statistics().dropped == 0)
    #expect(composer.skipped == 1)
    log.releaseParked()
    #expect(waitFor { log.parkedCount == 1 }, "the newer time on air's picture composes next")
    log.releaseParked()
    #expect(composer.waitUntilIdle())
    #expect(log.deliveries.map(\.sequence) == [1, 3])
  }

  @Test("A late picture from an earlier time on air does not displace the current one's")
  func staleGenerationIsIgnored() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      log.park(buffer, completion)
      return true
    }
    let buffer = try picture()
    composer.submit(job(buffer, from: Self.cameraB, index: 0))
    #expect(waitFor { log.parkedCount == 1 })
    composer.submit(job(buffer, from: Self.cameraA, index: 1, generation: 3))
    composer.submit(job(buffer, from: Self.cameraA, index: 2, generation: 1))
    #expect(composer.skipped == 1)
    log.releaseParked()
    #expect(waitFor { log.parkedCount == 1 })
    log.releaseParked()
    #expect(composer.waitUntilIdle())
    #expect(log.deliveries.map(\.sequence) == [1, 2], "the current time on air's picture was kept")
  }

  @Test("The average reads zero once nothing has composed for a couple of seconds")
  func averageGoesQuietWhenIdle() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      completion(buffer)
      return true
    }
    composer.setComposeDelay(milliseconds: 10)
    composer.submit(job(try picture()))
    #expect(composer.waitUntilIdle())
    #expect(composer.statistics().millisecondsAverage >= 10)
    Thread.sleep(forTimeInterval: 2.2)
    let idle = composer.statistics()
    #expect(idle.millisecondsAverage == 0)
    #expect(idle.millisecondsMax == 0)
    #expect(composer.statistics().millisecondsAverage == 0, "reading twice changes nothing")

    // The next compose starts the average again rather than blending into the old one.
    composer.setComposeDelay(milliseconds: 40)
    composer.submit(job(try picture()))
    #expect(composer.waitUntilIdle())
    #expect(composer.statistics().millisecondsAverage >= 40)
  }

  @Test("Handover-to-delivery time reaches the statistics, reading resets nothing, and the delay is clamped")
  func statisticsAndDelay() throws {
    let log = Log()
    let composer = makeComposer(log: log) { buffer, completion in
      completion(buffer)
      return true
    }
    composer.setComposeDelay(milliseconds: 20)
    #expect(composer.composeDelayMilliseconds == 20)
    let buffer = try picture()
    for index in 0 ..< 3 {
      composer.submit(job(buffer, index: index))
      #expect(composer.waitUntilIdle())
    }
    let first = composer.statistics()
    #expect(first.millisecondsMax >= 20)
    #expect(first.millisecondsAverage >= 20)
    let second = composer.statistics()
    #expect(second.millisecondsMax >= 20, "reading does not reset the worst, so every reader sees it")
    #expect(second.millisecondsAverage == first.millisecondsAverage, "the average is kept")

    composer.setComposeDelay(milliseconds: 500)
    #expect(composer.composeDelayMilliseconds == 200)
    composer.setComposeDelay(milliseconds: -5)
    #expect(composer.composeDelayMilliseconds == 0)
    composer.setComposeDelay(milliseconds: .nan)
    #expect(composer.composeDelayMilliseconds == 0)
  }
}

/// The delivery times the composer judged waiting pictures against.
private final class Expected: @unchecked Sendable {
  private let lock = NSLock()
  private var all: [Double] = []

  func add(_ value: Double) {
    lock.lock()
    all.append(value)
    lock.unlock()
  }

  var values: [Double] {
    lock.lock()
    defer { lock.unlock() }
    return all
  }
}
