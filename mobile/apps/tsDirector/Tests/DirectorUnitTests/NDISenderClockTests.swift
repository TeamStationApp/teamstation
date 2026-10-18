import CNDI
import DirectorCore
@testable import DirectorNDI
import DirectorSources
import Foundation
import Testing

/// An NDI sender's own clock, replayed the way a Hollyland Cosmo C2 delivers it.
///
/// The Cosmo stamps every picture with time since it was powered on, so its clock reads a few
/// minutes or hours past 1970 and is 56 years from ours. It is steady, though: its stamps sit on an
/// even 60 fps grid, while its pictures reach the iPad in bursts, about 100 ms of nothing and then
/// six pictures 1.5 ms apart. And it reboots, every half hour or so, which puts its clock back to
/// zero. These replays check that every picture is placed by the sender's stamp mapped onto our
/// clock, whatever the distance between the two clocks, and that a reboot or a jump re-measures the
/// mapping at once instead of refusing pictures.
@Suite("NDI sender clock")
struct NDISenderClockTests {
  /// Our wall clock when the replay starts.
  private static let wallStart = 1_800_000_000.0
  private static let period = 1.0 / 60
  /// The least transit in the burst pattern: the last picture of a burst.
  private static let leastTransit = 0.010 + 5 * 0.0015

  private struct Sent {
    /// The sender's stamp, in seconds on its own clock.
    var sender: Double
    /// When it reaches us, on our wall clock.
    var arrival: Double
    /// When it was really captured, on our wall clock.
    var truth: Double
  }

  /// Pictures captured every 1/60 s from `truthStart` (our clock) with the sender's clock reading
  /// `senderStart` at the first, delivered in bursts: each 100 ms of pictures arrives together at
  /// the end of it, 1.5 ms apart.
  private static func burst(count: Int, truthStart: Double, senderStart: Double) -> [Sent] {
    (0 ..< count).map { index in
      let inBurst = index % 6
      let burstEnd = truthStart + Double(index - inBurst + 5) * period
      return Sent(
        sender: senderStart + Double(index) * period,
        arrival: burstEnd + 0.010 + Double(inBurst) * 0.0015,
        truth: truthStart + Double(index) * period
      )
    }
  }

  private static func frame(_ senderSeconds: Double) -> NDIlib_video_frame_v2_t {
    var frame = NDIlib_video_frame_v2_t()
    frame.xres = 1_920
    frame.yres = 1_080
    // What a Cosmo declares; it sends 60.
    frame.frame_rate_N = 120
    frame.frame_rate_D = 1
    frame.timestamp = Int64((senderSeconds * NDIReceiveClock.ticksPerSecond).rounded())
    return frame
  }

  private struct Placed {
    var sent: Sent
    var timing: NDIReceiveClock.Timing?
  }

  private static func replay(_ frames: [Sent], into clock: NDIReceiveClock, wall: FixedClock) -> [Placed] {
    frames.map { sent in
      wall.set(sent.arrival)
      return Placed(sent: sent, timing: clock.timing(for: frame(sent.sender)))
    }
  }

  /// How far a picture's capture time is from the truth, less the transit the minimum-delay filter
  /// deliberately leaves in (the least-delayed picture defines the offset).
  private static func error(_ placed: Placed) -> Double? {
    guard let capture = placed.timing?.captureWallClock?.seconds else { return nil }
    return capture - (placed.sent.truth + leastTransit)
  }

  /// Every picture after the first burst is placed within a frame of where it was captured.
  private static func expectPlacedBySender(_ placed: ArraySlice<Placed>, _ label: String) {
    for item in placed {
      guard let error = error(item) else {
        Issue.record("\(label): a picture was refused or not placed")
        return
      }
      #expect(abs(error) < period, "\(label): picture placed \(Int(error * 1_000)) ms from its capture")
      if abs(error) >= period { return }
    }
  }

  @Test("A clock 56 years from ours is believed, so bursty pictures are placed on the sender's even grid")
  func farClockIsBelieved() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    let placed = Self.replay(
      Self.burst(count: 600, truthStart: Self.wallStart, senderStart: 48_368),
      into: clock,
      wall: wall
    )
    #expect(placed.allSatisfy { $0.timing != nil })
    Self.expectPlacedBySender(placed[6...], "steady")
    // Even spacing despite the bursts: the stamps' grid, not the arrivals'.
    let captures = placed[6...].compactMap { $0.timing?.captureWallClock?.seconds }
    for (earlier, later) in zip(captures, captures.dropFirst()) {
      #expect(abs((later - earlier) - Self.period) < 0.001)
    }
  }

  /// The bench Cosmo delivers a burst every 100 ms, so a once-a-second sample taken from the first
  /// frame after the second is up is always the first of a burst, the most delayed frame. Held for
  /// ten seconds that read as the sender's clock stepping back, and moved every capture 60 ms late.
  @Test("A minute of bursts is not mistaken for a clock step: the window keeps each second's best")
  func burstsAreNotAClockStep() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    // Bursts of five, six and seven pictures in turn, so they do not line up with whole seconds,
    // each delivered at its end 1.5 ms apart. The least transit is the last of a five.
    var frames: [Sent] = []
    var index = 0
    var size = 5
    while index < 3_600 {
      let end = Self.wallStart + Double(index + size - 1) * Self.period
      for inBurst in 0 ..< size where index + inBurst < 3_600 {
        frames.append(Sent(
          sender: 48_368 + Double(index + inBurst) * Self.period,
          arrival: end + 0.010 + Double(inBurst) * 0.0015,
          truth: Self.wallStart + Double(index + inBurst) * Self.period
        ))
      }
      index += size
      size = size == 7 ? 5 : size + 1
    }
    let leastTransit = 0.010 + 4 * 0.0015
    let placed = Self.replay(frames, into: clock, wall: wall)
    #expect(clock.clockSteps == 0)
    for item in placed[7...] {
      let error = (item.timing?.captureWallClock?.seconds ?? 0) - (item.sent.truth + leastTransit)
      #expect(abs(error) < Self.period, "picture placed \(Int(error * 1_000)) ms from its capture")
      if abs(error) >= Self.period { break }
    }
    #expect(clock.clockReport.capturesFromSender == 3_600)
    #expect(clock.clockReport.lastCaptureAgeSeconds >= 0)
  }

  @Test("A reboot from a 20-minute uptime to zero recalibrates at once: nothing refused, capture continuous")
  func rebootRecalibrates() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    // Ten seconds at 20 minutes of uptime, then 25 s dark, then back with half a second of uptime.
    let before = Self.burst(count: 600, truthStart: Self.wallStart, senderStart: 1_200)
    let after = Self.burst(count: 600, truthStart: Self.wallStart + 35, senderStart: 0.5)
    let placedBefore = Self.replay(before, into: clock, wall: wall)
    let refusedBefore = clock.outOfOrderFrames
    let placedAfter = Self.replay(after, into: clock, wall: wall)

    #expect(placedAfter.allSatisfy { $0.timing != nil }, "pictures were refused after the reboot")
    #expect(clock.outOfOrderFrames == refusedBefore)
    #expect(clock.clockRestarts == 1)
    Self.expectPlacedBySender(placedBefore[6...], "before the reboot")
    Self.expectPlacedBySender(placedAfter[6...], "after the reboot")
    // Capture never runs backwards across the reboot, and the gap is the outage itself.
    let last = placedBefore.last?.timing?.captureWallClock?.seconds ?? 0
    let first = placedAfter.first?.timing?.captureWallClock?.seconds ?? 0
    #expect(first > last)
    let afterCaptures = placedAfter.compactMap { $0.timing?.captureWallClock?.seconds }
    #expect(zip(afterCaptures, afterCaptures.dropFirst()).allSatisfy { $0 < $1 })
    // The presentation counter carries straight on.
    let lastPresentation = placedBefore.last?.timing?.presentationTime.seconds ?? 0
    let firstPresentation = placedAfter.first?.timing?.presentationTime.seconds ?? 0
    #expect(abs(firstPresentation - lastPresentation - Self.period) < 1e-6)
  }

  @Test("A 15 s hang on the same clock is neither a jump nor a reboot")
  func hangKeepsTheClock() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    let before = Self.burst(count: 300, truthStart: Self.wallStart, senderStart: 1_200)
    let after = Self.burst(count: 300, truthStart: Self.wallStart + 20, senderStart: 1_220)
    let placed = Self.replay(before + after, into: clock, wall: wall)
    #expect(placed.allSatisfy { $0.timing != nil })
    #expect(clock.clockRestarts == 0)
    #expect(clock.outOfOrderFrames == 0)
    Self.expectPlacedBySender(placed[6...], "across the hang")
  }

  @Test("One or two reordered pictures are dropped and counted, and the clock is kept")
  func reorderedPicturesAreDropped() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    var frames = Self.burst(count: 300, truthStart: Self.wallStart, senderStart: 1_200)
    // Picture 120 arrives in 121's slot and 121 in 120's; 200 and 202 likewise, so 201 and 200
    // both come after 202. Same arrival times, swapped pictures.
    func swapPictures(_ first: Int, _ second: Int) {
      let (sender, truth) = (frames[first].sender, frames[first].truth)
      (frames[first].sender, frames[first].truth) = (frames[second].sender, frames[second].truth)
      (frames[second].sender, frames[second].truth) = (sender, truth)
    }
    swapPictures(120, 121)
    swapPictures(200, 202)
    let placed = Self.replay(frames, into: clock, wall: wall)
    #expect(placed.filter { $0.timing == nil }.count == 3)
    #expect(clock.outOfOrderFrames == 3)
    #expect(clock.clockRestarts == 0)
    Self.expectPlacedBySender(placed[6...].filter { $0.timing != nil }[...], "around the reordering")
  }

  @Test("A forward jump from uptime to real UTC re-anchors at once")
  func forwardJumpReanchors() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    let before = Self.burst(count: 300, truthStart: Self.wallStart, senderStart: 1_200)
    // The sender sets its clock: 2 s ahead of ours from here on.
    let after = Self.burst(count: 300, truthStart: Self.wallStart + 5, senderStart: Self.wallStart + 7)
    let placedBefore = Self.replay(before, into: clock, wall: wall)
    let placedAfter = Self.replay(after, into: clock, wall: wall)
    #expect(placedAfter.allSatisfy { $0.timing != nil })
    #expect(clock.clockRestarts == 1)
    Self.expectPlacedBySender(placedBefore[6...], "before the jump")
    Self.expectPlacedBySender(placedAfter[6...], "after the jump")
  }

  @Test("One picture stamped an hour off between normal ones is an outlier: no restart, the offset kept")
  func loneOutlierIsIgnored() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    var frames = Self.burst(count: 600, truthStart: Self.wallStart, senderStart: 1_200)
    let before = Self.replay(Array(frames[..<300]), into: clock, wall: wall)
    let offsetBefore = clock.clockReport.filteredOffsetSeconds
    // Picture 300 carries a stamp an hour ahead; everything around it is on the sender's clock.
    frames[300].sender += 3_600
    let after = Self.replay(Array(frames[300...]), into: clock, wall: wall)
    #expect(clock.clockRestarts == 0)
    #expect(clock.outOfOrderFrames == 0)
    #expect(abs(clock.clockReport.filteredOffsetSeconds - offsetBefore) < 0.000_1)
    // The outlier is placed at its arrival, not refused; every other picture by the sender's clock.
    #expect(after.first?.timing?.isSenderCapture == false)
    #expect(after.first?.timing?.captureWallClock?.seconds == frames[300].arrival)
    Self.expectPlacedBySender(before[6...], "before the outlier")
    Self.expectPlacedBySender(after.dropFirst(), "after the outlier")
  }

  /// The Director backgrounded for 15 s: the SDK then hands over the pictures it queued before the
  /// stall, their stamps carrying on from the last, then fresh ones on the same running clock.
  @Test("Stale pictures after a 15 s receive stall are late on the running clock: no restart, the offset kept")
  func receiveBacklogIsNotAJump() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    let before = Self.burst(count: 600, truthStart: Self.wallStart, senderStart: 1_200)
    let placedBefore = Self.replay(before, into: clock, wall: wall)
    let offsetBefore = clock.clockReport.filteredOffsetSeconds
    let stallEnds = (before.last?.arrival ?? 0) + 15
    // Three pictures taken just before the stall, all delivered when it ends.
    var stale: [Sent] = []
    for index in 0 ..< 3 {
      let taken = Double(600 + index) * Self.period
      let arrival: Double = stallEnds + Double(index) * 0.0015
      stale.append(Sent(sender: 1_200 + taken, arrival: arrival, truth: Self.wallStart + taken))
    }
    let freshStart: Double = stallEnds + 0.05
    let fresh = Self.burst(count: 300, truthStart: freshStart, senderStart: 1_200 + (freshStart - Self.wallStart))
    let placedStale = Self.replay(stale, into: clock, wall: wall)
    let placedFresh = Self.replay(fresh, into: clock, wall: wall)
    #expect(clock.clockRestarts == 0)
    #expect(clock.outOfOrderFrames == 0)
    #expect(abs(clock.clockReport.filteredOffsetSeconds - offsetBefore) < 0.000_1)
    Self.expectPlacedBySender(placedBefore[6...], "before the stall")
    // The stale pictures are placed when they were taken, through the offset already measured.
    Self.expectPlacedBySender(placedStale[...], "the stale pictures")
    Self.expectPlacedBySender(placedFresh[...], "after the stall")
  }

  /// A sender whose clock stopped while it was down: 30 s dark, then its stamps carry on 1/60 s
  /// after the last, so every frame reads as backlog against the running offset.
  @Test("A clock that paused through a 30 s outage is re-measured within half a second, not taken as backlog for ever")
  func pausedClockRecalibrates() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    let before = Self.burst(count: 600, truthStart: Self.wallStart, senderStart: 1_200)
    let resumeAt: Double = Self.wallStart + 40
    let after = Self.burst(count: 600, truthStart: resumeAt, senderStart: 1_200 + 600 * Self.period)
    let placedBefore = Self.replay(before, into: clock, wall: wall)
    let placedAfter = Self.replay(after, into: clock, wall: wall)
    #expect(placedAfter.allSatisfy { $0.timing != nil })
    #expect(clock.clockRestarts == 1)
    Self.expectPlacedBySender(placedBefore[6...], "before the outage")
    // Back to capture plus the least transit within half a second and a burst.
    Self.expectPlacedBySender(placedAfter[42...], "after the clock was re-measured")
  }

  /// A UTC sender (a PC, a phone camera app) whose clock is corrected 2 s forward.
  @Test("A 2 s forward step is adopted within a quarter second, not held for ten")
  func forwardStepIsAdoptedQuickly() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    var frames = Self.burst(count: 1_200, truthStart: Self.wallStart, senderStart: 1_200)
    for index in 600 ..< frames.count { frames[index].sender += 2 }
    let placed = Self.replay(frames, into: clock, wall: wall)
    #expect(clock.clockRestarts == 0)
    #expect(clock.clockSteps == 1)
    Self.expectPlacedBySender(placed[6 ..< 600], "before the step")
    // Fifteen pictures is a quarter second at 60 fps.
    Self.expectPlacedBySender(placed[615...], "after the step")
  }

  /// The 2 s step again, through to the archive as `NDIFrameSource` drives it: the receive clock,
  /// the capture smoother, the archive moment and the ticker at 60 Hz.
  @Test("A 2 s forward step leaves no hole in the archive: no outage, no late cascade, nothing recorded 2 s off")
  func forwardStepLeavesNoArchiveHole() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    var frames = Self.burst(count: 1_200, truthStart: Self.wallStart, senderStart: Self.wallStart + 30)
    for index in 600 ..< frames.count { frames[index].sender += 2 }
    var smoother = CaptureTimelineSmoother()
    var ticker = ArchiveTicker<Int>(frameRate: 60)
    let delay = ArchiveTicker<Int>.defaultArchiveDelay
    var next = 0
    var outages = 0
    var worstLabel = 0.0
    var sequence: UInt64 = 0
    for tick in 0 ..< 1_150 {
      let now = Self.wallStart + delay + 0.03 + Double(tick) * Self.period
      while next < frames.count, frames[next].arrival <= now {
        wall.set(frames[next].arrival)
        if let timing = clock.timing(for: Self.frame(frames[next].sender)),
           let capture = timing.captureWallClock?.seconds {
          let smoothed = smoother.place(capture: capture, period: Self.period)
          let moment = NDIFrameSource.archiveMoment(
            arrived: frames[next].arrival,
            arrivedWall: frames[next].arrival,
            smoothedCapture: smoothed
          )
          sequence += 1
          ticker.add(ArchiveTicker<Int>.Picture(arrived: frames[next].arrival, due: moment + delay, sequence: sequence, payload: next))
        }
        next += 1
      }
      switch ticker.tick(at: now) {
      case .outage: outages += 1
      case let .encode(_, isRepeat):
        guard !isRepeat, let current = ticker.current, tick > 30 else { break }
        // Its label, the smoothed capture, against when it was really captured.
        let label = current.due - delay + ticker.sinceTaken
        worstLabel = max(worstLabel, abs(label - (frames[current.payload].truth + Self.leastTransit)))
      case .idle: break
      }
    }
    #expect(clock.clockSteps == 1)
    #expect(outages == 0)
    #expect(ticker.latePictures <= 3)
    #expect(ticker.repeatedTicks <= 3)
    #expect(worstLabel < 0.1, "a picture was recorded \(Int(worstLabel * 1_000)) ms from its capture")
  }

  /// A sender that stamps one picture late on its own side (by less than a clock jump) must not
  /// bias the minimum-delay filter for ten minutes: that one observation is the window's maximum,
  /// and every later capture would be placed early by as much.
  @Test("One picture stamped 80 ms late does not move every later capture time")
  func lateStampedOutlierDoesNotBias() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    var frames = Self.burst(count: 1_800, truthStart: Self.wallStart, senderStart: 1_200)
    // Ten seconds in, the last picture of a burst (the least delayed) is stamped 80 ms late.
    frames[605].sender += 0.080
    let placed = Self.replay(frames, into: clock, wall: wall)
    #expect(clock.clockRestarts == 0)
    Self.expectPlacedBySender(placed[6 ..< 605], "before the late stamp")
    // The four pictures stamped before it are refused as reordered, as any would be; the rest
    // are placed by the sender's clock, not 80 ms early.
    #expect(clock.outOfOrderFrames == 4)
    Self.expectPlacedBySender(placed[606...].filter { $0.timing != nil }[...], "after the late stamp")
  }

  @Test("A clock that steps forward 200 ms and stays there is adopted after the hold, not refused for ever")
  func forwardStepIsAdopted() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    var frames = Self.burst(count: 2_400, truthStart: Self.wallStart, senderStart: 1_200)
    for index in 600 ..< frames.count { frames[index].sender += 0.2 }
    let placed = Self.replay(frames, into: clock, wall: wall)
    #expect(clock.clockRestarts == 0)
    #expect(clock.clockSteps == 1)
    // Placed by the new clock once the step has held for its ten seconds.
    Self.expectPlacedBySender(placed[1_300...], "after the step was adopted")
  }

  @Test("A zero timestamp is still nonsense: the picture is placed at its arrival")
  func zeroTimestampFallsBack() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    wall.set(Self.wallStart + 1)
    var frame = Self.frame(0)
    frame.timestamp = 0
    let timing = clock.timing(for: frame)
    #expect(timing?.captureWallClock?.seconds == Self.wallStart + 1)
  }

  @Test("Sound from a sender 56 years away is placed through the pictures' offset, and follows a reboot")
  func soundFollowsTheSenderClock() {
    let wall = FixedClock(Self.wallStart)
    let clock = NDIReceiveClock(clock: wall)
    _ = Self.replay(Self.burst(count: 120, truthStart: Self.wallStart, senderStart: 1_200), into: clock, wall: wall)
    // Sound captured at our wallStart + 2.5 arrives 150 ms later.
    wall.set(Self.wallStart + 2.65)
    let placed = clock.audioCaptureSeconds(
      timestamp: Int64((1_202.5 * NDIReceiveClock.ticksPerSecond).rounded()),
      sampleIndex: 0,
      sampleRate: 48_000
    )
    #expect(abs(placed - (Self.wallStart + 2.5 + Self.leastTransit)) < 0.001)
    // After a reboot, sound that arrives before any picture has re-measured is not placed through
    // the old offset, which would put it twenty minutes in the past.
    wall.set(Self.wallStart + 40.02)
    let rebooted = clock.audioCaptureSeconds(
      timestamp: Int64((3.0 * NDIReceiveClock.ticksPerSecond).rounded()),
      sampleIndex: 0,
      sampleRate: 48_000
    )
    #expect(abs(rebooted - (Self.wallStart + 40.02)) < 0.001)
  }
}

@Suite("NDI timestamp log")
struct NDITimestampLogTests {
  @Test("Opening a log keeps only the newest CSVs, and nothing else in the directory")
  func pruneKeepsTheNewest() throws {
    let manager = FileManager.default
    let directory = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: directory) }
    for index in 0 ..< 5 {
      let url = directory.appendingPathComponent("cam-\(index).csv")
      try Data("x".utf8).write(to: url)
      try manager.setAttributes([ .modificationDate: Date(timeIntervalSince1970: Double(1_000 + index)) ], ofItemAtPath: url.path)
    }
    try Data("x".utf8).write(to: directory.appendingPathComponent("notes.txt"))
    NDITimestampLog.prune(directory, keeping: 2)
    let left = try manager.contentsOfDirectory(atPath: directory.path).sorted()
    #expect(left == [ "cam-3.csv", "cam-4.csv", "notes.txt" ])
    #expect(DirectorPaths.ndiTimestamps.lastPathComponent == "NDITimestamps")
  }
}
