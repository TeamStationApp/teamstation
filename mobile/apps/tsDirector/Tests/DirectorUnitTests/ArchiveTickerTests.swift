import CoreVideo
import DirectorCore
import DirectorSources
@testable import DirectorNDI
import Testing

private typealias Ticker = ArchiveTicker<Void>

@Suite("NDI archive clock")
struct ArchiveTickerTests {
  private let tick = 1.0 / 60

  @Test("A camera sending the archive's own rate is encoded one picture per tick, nothing repeated")
  func steadyCamera() {
    var ticker = Ticker(frameRate: 60)
    for index in 0 ..< 120 {
      let now = Double(index) * tick
      ticker.add(Ticker.Picture(arrived: now - 0.004, sequence: UInt64(index)))
      #expect(ticker.tick(at: now) == .encode(index: Int64(index), isRepeat: false))
    }
  }

  @Test("A 30 fps camera recorded at 60 has every picture encoded twice, evenly")
  func slowerCameraRepeats() {
    var ticker = Ticker(frameRate: 60)
    var repeats = 0
    for index in 0 ..< 60 {
      let now = Double(index) * tick
      let sequence = UInt64(index / 2)
      // Handed over once, as it arrives; the second tick of each pair has nothing new.
      if index % 2 == 0 { ticker.add(Ticker.Picture(arrived: Double(sequence) / 30, sequence: sequence)) }
      guard case let .encode(frame, isRepeat) = ticker.tick(at: now) else {
        Issue.record("tick \(index) encoded nothing")
        continue
      }
      #expect(frame == Int64(index))
      if isRepeat { repeats += 1 }
    }
    #expect(repeats == 30)
  }

  @Test("A stall shorter than the repeat window is filled with the last picture")
  func shortStallRepeats() {
    var ticker = Ticker(frameRate: 60)
    ticker.add(Ticker.Picture(arrived: 0, sequence: 1))
    _ = ticker.tick(at: 0)
    for index in 1 ... 24 {
      #expect(ticker.tick(at: Double(index) * tick) == .encode(index: Int64(index), isRepeat: true))
    }
  }

  /// rec-411's case in the small: two seconds without a picture, then the camera again.
  @Test("An outage encodes nothing, and the camera comes back as long after as it really was")
  func outageLeavesAGapOfItsOwnLength() {
    var ticker = Ticker(frameRate: 60)
    ticker.add(Ticker.Picture(arrived: 0, sequence: 1))
    _ = ticker.tick(at: 0)
    var outages = 0
    for index in 1 ..< 150 {
      if ticker.tick(at: Double(index) * tick) == .outage { outages += 1 }
    }
    // Repeats for the first half second, nothing after it.
    #expect(outages == 149 - 30)
    ticker.add(Ticker.Picture(arrived: 2.5 - 0.002, sequence: 2))
    #expect(ticker.tick(at: 2.5) == .encode(index: 150, isRepeat: false))
  }

  @Test("Nothing is encoded before the first picture, and a timer firing twice for one tick encodes once")
  func idleTicks() {
    var ticker = Ticker(frameRate: 60)
    #expect(ticker.tick(at: 0) == .idle)
    ticker.add(Ticker.Picture(arrived: 1, sequence: 1))
    #expect(ticker.tick(at: 1) == .encode(index: 0, isRepeat: false))
    #expect(ticker.tick(at: 1 + 0.001) == .idle)
  }

  @Test("A timer that fires late skips a tick number rather than stamping a frame early")
  func lateTimerSkipsANumber() {
    var ticker = Ticker(frameRate: 60)
    ticker.add(Ticker.Picture(arrived: 0, sequence: 0))
    _ = ticker.tick(at: 0)
    ticker.add(Ticker.Picture(arrived: 2 * tick, sequence: 1))
    #expect(ticker.tick(at: 2 * tick) == .encode(index: 2, isRepeat: false))
  }
}

/// The Cosmo C2's delivery: pictures captured on an even 60 fps grid, arriving 100 ms at a time.
@Suite("NDI archive by capture time")
struct ArchivePacingTests {
  private let period = 1.0 / 60

  private struct Arrival {
    var arrived: Double
    var picture: Ticker.Picture
  }

  /// Captured every 1/60 s from `start`, each 100 ms delivered at its end, six pictures 1.5 ms
  /// apart, due in the archive at capture plus the archive delay.
  private func bursts(count: Int, start: Double, firstSequence: UInt64) -> [Arrival] {
    (0 ..< count).map { index in
      let inBurst = index % 6
      let capture = start + Double(index) * period
      let arrived = start + Double(index - inBurst + 5) * period + 0.010 + Double(inBurst) * 0.0015
      return Arrival(
        arrived: arrived,
        picture: Ticker.Picture(
          arrived: arrived,
          due: capture + Ticker.defaultArchiveDelay,
          sequence: firstSequence + UInt64(index)
        )
      )
    }
  }

  /// Runs the archive's 60 Hz timer from `from` for `ticks` ticks, its firing a few ms late at
  /// random, handing over each picture as it arrives. Returns the sequence each tick encoded, or
  /// nil for a tick that encoded nothing.
  private func run(_ arrivals: [Arrival], ticker: inout Ticker, from: Double, ticks: Int) -> [UInt64?] {
    var next = 0
    var generator = SystemRandomNumberGenerator()
    var taken: [UInt64?] = []
    for tick in 0 ..< ticks {
      let now = from + Double(tick) * period + Double.random(in: 0 ... 0.003, using: &generator)
      while next < arrivals.count, arrivals[next].arrived <= now {
        ticker.add(arrivals[next].picture)
        next += 1
      }
      if case .encode = ticker.tick(at: now) {
        taken.append(ticker.current?.sequence)
      } else {
        taken.append(nil)
      }
    }
    return taken
  }

  @Test("Bursty arrivals with even capture times: one distinct picture per tick, none held, none skipped")
  func burstsMakeNoRepeats() {
    var ticker = Ticker(frameRate: 60)
    let taken = run(bursts(count: 1_200, start: 0, firstSequence: 1), ticker: &ticker, from: 0.007, ticks: 1_150)
    let encoded = taken.compactMap { $0 }
    #expect(encoded.count > 1_100)
    for (earlier, later) in zip(encoded, encoded.dropFirst()) {
      #expect(later == earlier + 1, "tick took \(later) after \(earlier)")
      if later != earlier + 1 { break }
    }
    #expect(ticker.repeatedTicks == 0)
    #expect(ticker.skippedPictures == 0)
  }

  @Test("A camera that reboots leaves a gap as long as its outage, and the count runs on through it")
  func rebootGap() {
    var ticker = Ticker(frameRate: 60)
    // Ten seconds, 25 s dark, ten more: the capture times on our clock carry on across the reboot.
    let before = bursts(count: 600, start: 0, firstSequence: 1)
    let after = bursts(count: 600, start: 35, firstSequence: 601)
    var indices: [Int64] = []
    var outages = 0
    var next = 0
    let arrivals = before + after
    // To 45.2 s, short of the last picture's moment (45.25 s), so the run ends on footage.
    for tick in 0 ..< 2_711 {
      let now = 0.007 + Double(tick) * period
      while next < arrivals.count, arrivals[next].arrived <= now {
        ticker.add(arrivals[next].picture)
        next += 1
      }
      switch ticker.tick(at: now) {
      case let .encode(index, _): indices.append(index)
      case .outage: outages += 1
      case .idle: break
      }
    }
    // Monotonic, one number per tick, and the outage is the camera's own 25 s less the repeat window.
    #expect(zip(indices, indices.dropFirst()).allSatisfy { $0 < $1 })
    let outageSeconds = Double(outages) * period
    #expect(abs(outageSeconds - (25 - Ticker.defaultRepeatWindow)) < 0.1)
    #expect(ticker.skippedPictures == 0)
    #expect(ticker.repeatedTicks <= 31)
  }

  @Test("A picture due before the one already taken is dropped as late, not encoded out of order")
  func latePictureIsDropped() {
    var ticker = Ticker(frameRate: 60)
    ticker.add(Ticker.Picture(arrived: 0, due: 0.25, sequence: 1))
    #expect(ticker.tick(at: 0.25) == .encode(index: 0, isRepeat: false))
    ticker.add(Ticker.Picture(arrived: 0.26, due: 0.24, sequence: 2))
    #expect(ticker.latePictures == 1)
    #expect(ticker.tick(at: 0.25 + period) == .encode(index: 1, isRepeat: true))
  }

  @Test("A camera a little faster than the archive loses one picture now and then, never a hold and a skip")
  func fasterCameraSkipsCleanly() {
    var ticker = Ticker(frameRate: 60)
    // 60.5 fps for 20 s: about ten pictures too many.
    let arrivals = (0 ..< 1_210).map { index -> Arrival in
      let capture = Double(index) / 60.5
      return Arrival(
        arrived: capture + 0.02,
        picture: Ticker.Picture(arrived: capture + 0.02, due: capture + 0.25, sequence: UInt64(index + 1))
      )
    }
    let taken = run(arrivals, ticker: &ticker, from: 0.25, ticks: 1_180).compactMap { $0 }
    #expect(ticker.repeatedTicks == 0)
    #expect(ticker.skippedPictures >= 8 && ticker.skippedPictures <= 12)
    #expect(zip(taken, taken.dropFirst()).allSatisfy { $1 == $0 + 1 || $1 == $0 + 2 })
  }

  /// The ticker is the only store of the pictures it may take. A second store with its own bound
  /// once evicted the picture the ticker was repeating, and the repeat tick then encoded nothing.
  @Test("A refused picture is not kept, and the picture a tick repeats is still the one held")
  func refusedPicturesAreNotKept() {
    var ticker = ArchiveTicker<String>(frameRate: 60)
    let firstAccepted = ticker.add(ArchiveTicker<String>.Picture(arrived: 0, due: 0.25, sequence: 1, payload: "first"))
    #expect(firstAccepted)
    #expect(ticker.tick(at: 0.25) == .encode(index: 0, isRepeat: false))
    // A full queue of pictures not yet due, then two the ticker refuses as late and one as a repeat.
    for index in 0 ..< Ticker.maximumQueued {
      let due = 1 + Double(index) * period
      let queuedAccepted = ticker.add(ArchiveTicker<String>.Picture(arrived: 0.26, due: due, sequence: UInt64(index + 2), payload: "queued"))
      #expect(queuedAccepted)
    }
    let firstLate = ticker.add(ArchiveTicker<String>.Picture(arrived: 0.27, due: 0.5, sequence: 100, payload: "late"))
    #expect(!firstLate)
    let secondLate = ticker.add(ArchiveTicker<String>.Picture(arrived: 0.27, due: 0.6, sequence: 101, payload: "late"))
    #expect(!secondLate)
    let repeatAccepted = ticker.add(ArchiveTicker<String>.Picture(arrived: 0.27, due: 9, sequence: 3, payload: "repeat"))
    #expect(!repeatAccepted)
    #expect(ticker.latePictures == 2)
    #expect(ticker.heldCount == Ticker.maximumQueued + 1)
    // Each repeat tick still has the picture it repeats, payload and all.
    for index in 1 ... 10 {
      #expect(ticker.tick(at: 0.25 + Double(index) * period) == .encode(index: Int64(index), isRepeat: true))
      #expect(ticker.current?.payload == "first")
    }
  }

  /// A 4K NDI source's pool lends 8 pictures, and the full 250 ms delay at 60 fps would hold 21.
  @Test("A small pixel pool caps what the archive holds, and the archive keeps recording")
  func smallPoolCapsTheArchive() {
    let small = NDIFrameSource.archiveBudget(poolFrames: 8, rate: 60)
    #expect(small.queueLimit == 7)
    #expect(small.delay < Ticker.defaultArchiveDelay)
    // At 1080p the pool is no constraint, and the full delay stands.
    let large = NDIFrameSource.archiveBudget(poolFrames: 56, rate: 60)
    #expect(large.delay == Ticker.defaultArchiveDelay)
    #expect(large.queueLimit >= Int((60 * (Ticker.defaultArchiveDelay + NDIFrameSource.archiveBurstSeconds)).rounded(.up)))

    var ticker = Ticker(frameRate: 60)
    ticker.queueLimit = small.queueLimit
    // The Cosmo's bursts, due at capture plus the shortened delay.
    let arrivals = bursts(count: 600, start: 0, firstSequence: 1).map { arrival -> Arrival in
      var shortened = arrival
      shortened.picture.due += small.delay - Ticker.defaultArchiveDelay
      return shortened
    }
    var next = 0
    var mostHeld = 0
    var encoded = 0
    for tick in 0 ..< 590 {
      let now = 0.007 + Double(tick) * period
      while next < arrivals.count, arrivals[next].arrived <= now {
        ticker.add(arrivals[next].picture)
        mostHeld = max(mostHeld, ticker.heldCount)
        next += 1
      }
      if case .encode = ticker.tick(at: now) { encoded += 1 }
    }
    // Never more than the pool lends, and every tick after the first picture encodes something.
    #expect(mostHeld <= 8)
    #expect(encoded >= 575)
  }

  /// A sender whose pictures switch between stamped and unstamped: both are due at their moment
  /// plus the same delay, the unstamped ones at arrival, so the archive carries straight on.
  @Test("Switching between arrival-placed and capture-placed pictures neither holds for the delay nor skips the queue")
  func switchingPlacementSharesOneTimeline() {
    var ticker = Ticker(frameRate: 60)
    let delay = Ticker.defaultArchiveDelay
    // Five seconds of each in turn: steady 60 fps, 20 ms transit.
    let arrivals = (0 ..< 1_200).map { index -> Arrival in
      let capture = Double(index) * period
      let arrived = capture + 0.020
      let stamped = (index / 300) % 2 == 1
      return Arrival(
        arrived: arrived,
        picture: Ticker.Picture(
          arrived: arrived,
          due: (stamped ? capture : arrived) + delay,
          sequence: UInt64(index + 1)
        )
      )
    }
    let taken = run(arrivals, ticker: &ticker, from: delay + 0.020, ticks: 1_150).compactMap { $0 }
    // Two ticks of the 20 ms transit at most, three times over; nothing like the 15-tick hold.
    #expect(ticker.repeatedTicks <= 6)
    #expect(ticker.skippedPictures + ticker.latePictures <= 6)
    #expect(zip(taken, taken.dropFirst()).allSatisfy { $1 >= $0 && $1 <= $0 + 3 })
  }

  /// Stop pressed at `stop`: the pictures captured in the last delay are still queued, due after it.
  @Test("Draining at the stop encodes the queued pictures on their ticks, so the archive reaches the stop")
  func drainReachesTheStop() {
    var ticker = Ticker(frameRate: 60)
    let delay = Ticker.defaultArchiveDelay
    let arrivals = bursts(count: 600, start: 0, firstSequence: 1)
    let stop = 5.0
    let delivered = arrivals.filter { $0.arrived <= stop }
    let taken = run(delivered, ticker: &ticker, from: 0.007, ticks: Int((stop - 0.007) / period))
    let lastBefore = taken.compactMap { $0 }.last ?? 0
    // The last burst before the stop lands after the last tick; handed over as it arrives.
    for arrival in delivered { ticker.add(arrival.picture) }
    let drained = ticker.drain(through: stop + delay)
    // Every queued picture, one per consecutive tick, the last of them the last delivered.
    #expect(!drained.isEmpty)
    #expect(drained.first?.picture.sequence == lastBefore + 1)
    #expect(drained.last?.picture.sequence == delivered.last?.picture.sequence)
    #expect(zip(drained, drained.dropFirst()).allSatisfy { $1.index == $0.index + 1 })
    // The last tick stands for a capture at the stop, give or take a frame and the burst it was in.
    let lastCapture = (drained.last?.tickTime ?? 0) - delay
    #expect(lastCapture >= stop - 0.1 - period)
    #expect(ticker.heldCount == 1)
  }

  @Test("The counts survive a restart, as the other archive counters do across takes")
  func countsSurviveRestart() {
    var ticker = Ticker(frameRate: 60)
    ticker.add(Ticker.Picture(arrived: 0, sequence: 1))
    _ = ticker.tick(at: 0)
    _ = ticker.tick(at: period)
    ticker.add(Ticker.Picture(arrived: 0.02, due: -1, sequence: 2))
    #expect(ticker.repeatedTicks == 1)
    #expect(ticker.latePictures == 1)
    ticker.restart(frameRate: 30)
    #expect(ticker.heldCount == 0)
    #expect(ticker.frameRate == 30)
    #expect(ticker.repeatedTicks == 1)
    #expect(ticker.latePictures == 1)
    // And it starts again from a fresh clock.
    ticker.add(Ticker.Picture(arrived: 10, sequence: 1))
    #expect(ticker.tick(at: 10) == .encode(index: 0, isRepeat: false))
  }

  /// A 1080p camera switched to 4K mid-stream: the delay falls from 250 ms to about 17 ms.
  @Test("A shrunken delay re-bases the queue: new pictures are not refused while the old queue drains")
  func shrunkenDelayRebasesTheQueue() {
    var ticker = Ticker(frameRate: 60)
    let long = Ticker.defaultArchiveDelay
    let small = NDIFrameSource.archiveBudget(poolFrames: 8, rate: 60)
    var arrivals = (0 ..< 120).map { index -> Arrival in
      let capture = Double(index) * period
      return Arrival(arrived: capture + 0.02, picture: Ticker.Picture(arrived: capture + 0.02, due: capture + long, sequence: UInt64(index + 1)))
    }
    _ = run(arrivals, ticker: &ticker, from: long, ticks: 100)
    // The budget changes as the next pictures arrive.
    ticker.shiftDue(by: small.delay - long)
    ticker.queueLimit = small.queueLimit
    #expect(ticker.heldCount <= small.queueLimit + 1)
    let lateBefore = ticker.latePictures
    arrivals = (120 ..< 240).map { index -> Arrival in
      let capture = Double(index) * period
      return Arrival(arrived: capture + 0.02, picture: Ticker.Picture(arrived: capture + 0.02, due: capture + small.delay, sequence: UInt64(index + 1)))
    }
    let taken = run(arrivals, ticker: &ticker, from: long + 100 * period, ticks: 110).compactMap { $0 }
    #expect(ticker.latePictures == lateBefore)
    #expect(ticker.heldCount <= small.queueLimit + 1)
    #expect((taken.last ?? 0) >= 220)
  }

  /// Each encoded frame's label (its picture's capture plus `sinceTaken`) against its content's
  /// real capture, and the tick-based label it used to get, over a camera at `cameraRate` into an
  /// archive at `archiveRate`.
  private func labelErrors(cameraRate: Double, archiveRate: Int) -> (label: Double, tick: Double) {
    var ticker = Ticker(frameRate: archiveRate)
    let delay = Ticker.defaultArchiveDelay
    let tickPeriod = 1 / Double(archiveRate)
    var labelError = 0.0
    var tickError = 0.0
    var count = 0
    var next = 0
    let pictures = (0 ..< Int(cameraRate * 20)).map { index -> Ticker.Picture in
      let capture = Double(index) / cameraRate
      return Ticker.Picture(arrived: capture + 0.02, due: capture + delay, sequence: UInt64(index + 1))
    }
    var generator = SystemRandomNumberGenerator()
    for tick in 0 ..< archiveRate * 19 {
      let now = delay + Double(tick) * tickPeriod + Double.random(in: 0 ... 0.003, using: &generator)
      while next < pictures.count, pictures[next].arrived <= now {
        ticker.add(pictures[next])
        next += 1
      }
      guard case let .encode(_, isRepeat) = ticker.tick(at: now), !isRepeat,
            let current = ticker.current, let tickTime = ticker.lastTickTime else { continue }
      let capture = current.due - delay
      labelError += abs(capture + ticker.sinceTaken - capture)
      tickError += abs(capture + (tickTime - current.due) - capture)
      count += 1
    }
    return (labelError / Double(max(1, count)), tickError / Double(max(1, count)))
  }

  @Test("A camera faster than the archive is labelled by its pictures' own capture, not a tick and a half late")
  func fasterCameraLabelledByItsOwnCapture() {
    // 60 fps into a 30 fps archive sits at the back of the band: 50 ms late by the tick.
    let halfRate = labelErrors(cameraRate: 60, archiveRate: 30)
    #expect(halfRate.label < 0.005)
    #expect(halfRate.tick > 0.030)
    // A fast crystal wanders between half a tick and a tick and a half behind.
    let fastCrystal = labelErrors(cameraRate: 60.5, archiveRate: 60)
    #expect(fastCrystal.label < 0.005)
    #expect(fastCrystal.tick > 0.008)
  }

  /// A 100 ms disk cap is the operator's lowest; the archive's hold is 250 ms.
  @Test("An even sender's archive frames pass a 100 ms disk cap: their age is transit, not the archive's hold")
  func archiveFramesPassALowDiskCap() {
    let gate = FrameLatencyGate(caps: .init(diskSeconds: 0.1))
    var ticker = Ticker(frameRate: 60)
    let delay = Ticker.defaultArchiveDelay
    let transit = 0.02
    var admitted = 0
    var refusedByHold = 0
    var next = 0
    let pictures = (0 ..< 600).map { index -> Ticker.Picture in
      let capture = Double(index) * period
      return Ticker.Picture(arrived: capture + transit, due: capture + delay, sequence: UInt64(index + 1))
    }
    for tick in 0 ..< 560 {
      let now = delay + Double(tick) * period
      while next < pictures.count, pictures[next].arrived <= now {
        ticker.add(pictures[next])
        next += 1
      }
      guard case .encode = ticker.tick(at: now), let current = ticker.current else { continue }
      let times = NDIFrameSource.archiveFrameTimes(
        captureWall: current.due - delay,
        transit: transit,
        sinceTaken: ticker.sinceTaken
      )
      #expect(gate.admitsForDisk(captured: times.capture, now: times.arrival))
      admitted += 1
      // Stamped with the time it was encoded, as it was: the hold counted as age.
      if !gate.admitsForDisk(captured: times.capture, now: WallClock(seconds: now + 0.005)) { refusedByHold += 1 }
    }
    #expect(admitted > 550)
    #expect(refusedByHold == admitted)
  }

  /// The receive clock places a lone unconfirmed-jump picture at its arrival. Inside the Cosmo's
  /// 100 ms bursts that arrival is up to a burst after its slot on the capture grid.
  @Test("One arrival-placed picture inside 100 ms bursts, smoothed onto the grid: no repeats, no late pictures")
  func arrivalPlacedOutlierInsideBursts() {
    let delay = Ticker.defaultArchiveDelay
    let leastTransit = 0.010 + 5 * 0.0015
    let outlier = 303
    func dues(smoothed: Bool) -> [Arrival] {
      var smoother = CaptureTimelineSmoother()
      return bursts(count: 1_200, start: 0, firstSequence: 1).enumerated().map { index, arrival in
        // Placed by the sender's clock (true capture plus the least transit), except the outlier.
        let capture = index == outlier ? arrival.arrived : Double(index) * period + leastTransit
        let placed = smoother.place(capture: capture, period: period)
        var moved = arrival
        moved.picture.due = smoothed
          ? NDIFrameSource.archiveMoment(arrived: arrival.arrived, arrivedWall: arrival.arrived, smoothedCapture: placed) + delay
          : (index == outlier ? arrival.arrived : placed) + delay
        return moved
      }
    }
    var ticker = Ticker(frameRate: 60)
    _ = run(dues(smoothed: true), ticker: &ticker, from: 0.007 + leastTransit, ticks: 1_150)
    #expect(ticker.repeatedTicks == 0)
    #expect(ticker.latePictures == 0)
    // Its raw arrival instead, as before: a hold, then its neighbours refused as late.
    var raw = Ticker(frameRate: 60)
    _ = run(dues(smoothed: false), ticker: &raw, from: 0.007 + leastTransit, ticks: 1_150)
    #expect(raw.repeatedTicks + raw.latePictures > 0)
  }
}

@Suite("NDI archive scaling")
struct ArchiveScalerTests {
  private func picture(width: Int, height: Int, luma: UInt8) throws -> CVPixelBuffer {
    var made: CVPixelBuffer?
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()]
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &made)
    let buffer = try #require(made)
    CVPixelBufferLockBaseAddress(buffer, [])
    for plane in 0 ..< 2 {
      let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane)!
      memset(base, plane == 0 ? Int32(luma) : 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane))
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  private func luma(_ buffer: CVPixelBuffer, x: Int, y: Int) -> UInt8 {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
    return base[y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) + x]
  }

  @Test("A picture already the archive's size is passed through untouched")
  func sameSizePassesThrough() throws {
    let scaler = try #require(ArchiveScaler(width: 1920, height: 1080))
    let source = try picture(width: 1920, height: 1080, luma: 200)
    #expect(scaler.scale(source) === source)
  }

  @Test("A 720p picture is scaled up to fill a 1080p archive")
  func smallerPictureFills() throws {
    let scaler = try #require(ArchiveScaler(width: 1920, height: 1080))
    let output = try #require(scaler.scale(try picture(width: 1280, height: 720, luma: 180)))
    #expect(CVPixelBufferGetWidth(output) == 1920)
    #expect(CVPixelBufferGetHeight(output) == 1080)
    #expect(abs(Int(luma(output, x: 20, y: 540)) - 180) < 8)
  }

  @Test("A 4:3 picture is fitted inside a 16:9 archive with black bars at the sides")
  func otherShapeIsLetterboxed() throws {
    let scaler = try #require(ArchiveScaler(width: 1920, height: 1080))
    let output = try #require(scaler.scale(try picture(width: 640, height: 480, luma: 200)))
    #expect(CVPixelBufferGetWidth(output) == 1920)
    #expect(luma(output, x: 20, y: 540) <= 20)
    #expect(abs(Int(luma(output, x: 960, y: 540)) - 200) < 8)
  }
}
