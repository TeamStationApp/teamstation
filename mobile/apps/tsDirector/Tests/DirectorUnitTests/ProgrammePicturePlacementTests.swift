import DirectorCore
@testable import DirectorPipeline
@testable import DirectorRTSP
import DirectorSources
import Foundation
import Testing

/// Programme pictures are taken on the programme tick by capture time plus D, the moment their
/// sound plays (U-D4). TS Director's live stream of a 30 fps day, and of a phone swinging between
/// 30 and 60 fps from heat, stuttered: the programme took whatever picture was newest.
@Suite("Programme picture placement")
struct ProgrammePicturePlacementTests {
  @Test("The delay line never holds past D, cap on or off: off holds it to 1 s, as D is")
  func playoutCapIsD() {
    #expect(TileRouter.playoutCapMilliseconds(capEnabled: false, capMilliseconds: 2_000) == 1_000)
    #expect(TileRouter.playoutCapMilliseconds(capEnabled: true, capMilliseconds: 400) == 400)
    #expect(TileRouter.playoutCapMilliseconds(capEnabled: true, capMilliseconds: 3_000) == 2_000)
    for (enabled, cap) in [ (false, 0.0), (true, 250.0), (true, 1_500.0) ] {
      #expect(
        TileRouter.playoutCapMilliseconds(capEnabled: enabled, capMilliseconds: cap)
          == TileRouter.liveSoundDelaySeconds(capEnabled: enabled, capMilliseconds: cap) * 1_000
      )
    }
  }

  @Test("A saved 2 s hold seeds a camera at the cap, and the camera then decays to what it needs")
  func savedHoldIsClampedAndDecays() {
    let coordinator = PlayoutCoordinator()
    coordinator.seed(2_000, for: SourceID("1st"))
    #expect(coordinator.seedMilliseconds(for: SourceID("1st")) == 2_000)
    coordinator.setCap(milliseconds: 500)
    let seed = coordinator.seedMilliseconds(for: SourceID("1st"))
    #expect(seed == 500)

    var controller = PlayoutController(seedMilliseconds: seed ?? 0)
    controller.setCeiling(milliseconds: coordinator.latencyCapMilliseconds)
    #expect(controller.requirementMilliseconds == 500)
    // A healthy camera: every picture 10 ms after capture, none late, so nothing holds the delay:
    // from the clamped seed it gives it back at 1% of real time, 10 ms a second.
    var buffers: [Double] = []
    for frame in 0 ..< (60 * 120) {
      let now = Double(frame) / 60
      controller.advance(to: now)
      controller.note(lateness: 0.01, at: now)
      if frame % 60 == 0 { buffers.append(controller.bufferMilliseconds) }
    }
    #expect(buffers.allSatisfy { $0 <= 500 })
    #expect(buffers[10] > 380 && buffers[10] < 420)
    #expect(buffers[110] < 150)
    #expect(controller.requirementMilliseconds < 100)

    // Without a cap a saved hold is seeded as it was, and a controller seeded so reports it, capped.
    var uncapped = PlayoutController(seedMilliseconds: 2_000)
    #expect(uncapped.requirementMilliseconds == 2_000)
    uncapped.setCeiling(milliseconds: 500)
    #expect(uncapped.requirementMilliseconds == 500)
  }

  /// Ticks at `tickRate` from `start` for `seconds`; pictures captured at `captures` arrive
  /// `arrivalDelay` after capture. Returns the picture (its capture time) shown on each tick.
  private func shown(
    captures: [Double],
    tickRate: Double = 60,
    start: Double = 100.5,
    seconds: Double,
    delay: Double = 0.5,
    arrivalDelay: (Double) -> Double = { _ in 0.3 }
  ) -> (picks: [Double?], queue: ProgrammePictureQueue<Double>) {
    var queue = ProgrammePictureQueue<Double>(delaySeconds: delay)
    var pending = captures.map { ($0 + arrivalDelay($0), $0) }.sorted { $0.0 < $1.0 }
    var picks: [Double?] = []
    let ticks = Int(seconds * tickRate)
    for index in 0 ..< ticks {
      let now = start + Double(index) / tickRate
      while let next = pending.first, next.0 <= now {
        queue.add(next.1, capture: next.1)
        pending.removeFirst()
      }
      picks.append(queue.pick(at: now, period: 1 / tickRate)?.picture)
    }
    return (picks, queue)
  }

  @Test("A 30 fps camera on a 60 fps programme repeats every other tick")
  func thirtyOnSixty() {
    let captures = (0 ..< 120).map { 100 + Double($0) / 30 + 0.004 }
    let (picks, queue) = shown(captures: captures, seconds: 2)
    // Every picture in turn, none skipped, each shown for two ticks.
    var runs: [Int] = []
    var length = 1
    for (a, b) in zip(picks.dropFirst(), picks) {
      if a == b { length += 1 } else { runs.append(length); length = 1 }
    }
    #expect(runs.count > 50)
    #expect(runs.dropFirst().dropLast().allSatisfy { $0 == 2 })
    #expect(queue.skippedPictures == 0)
    #expect(queue.latePictures == 0)
  }

  @Test("A camera switching from 30 to 60 fps changes only the repeat pattern")
  func thirtyToSixty() {
    let slow = (0 ..< 60).map { 100 + Double($0) / 30 + 0.004 }
    let fast = (0 ..< 120).map { 102 + Double($0) / 60 + 0.004 }
    let (picks, queue) = shown(captures: slow + fast, seconds: 3.5)
    // Shown in capture order, never going back, never skipping a picture.
    let distinct = picks.compactMap { $0 }.reduce(into: [Double]()) { if $0.last != $1 { $0.append($1) } }
    #expect(distinct == distinct.sorted())
    #expect(queue.skippedPictures == 0)
    // Each picture placed at its capture time plus D, to within a tick.
    for (index, pick) in picks.enumerated() {
      guard let pick else { continue }
      let tick = 100.5 + Double(index) / 60
      #expect(tick - (pick + 0.5) >= -0.002 && tick - (pick + 0.5) < 1 / 30 + 0.002)
    }
  }

  @Test("A picture later than D is dropped and does not delay the others")
  func latePictureDropped() {
    let captures = (0 ..< 60).map { 100 + Double($0) / 60 + 0.004 }
    // The picture captured at 100.5 arrives 0.6 s after capture, a whole tick past its moment.
    let late = captures[30]
    let (picks, queue) = shown(captures: captures, seconds: 1.5) { $0 == late ? 0.6 : 0.3 }
    #expect(!picks.contains(late))
    #expect(queue.latePictures == 1)
    // The pictures either side of it are shown on their own ticks.
    #expect(picks.contains(captures[29]))
    #expect(picks.contains(captures[31]))
  }

  @Test("Nothing is shown before the first picture is due; then the last repeats when none is new")
  func repeatsWhenNothingIsDue() {
    var queue = ProgrammePictureQueue<Double>(delaySeconds: 0.5)
    #expect(queue.pick(at: 100, period: 1 / 60) == nil)
    queue.add(99.6, capture: 99.6)
    #expect(queue.pick(at: 100.05, period: 1 / 60)?.picture == nil)
    #expect(queue.pick(at: 100.1, period: 1 / 60)?.picture == 99.6)
    #expect(queue.pick(at: 100.2, period: 1 / 60)?.picture == 99.6)
    // A replay picture has no capture time and is due at once.
    queue.add(-1, capture: nil)
    #expect(queue.pick(at: 100.21, period: 1 / 60)?.picture == -1)
    // A cut drops what was waiting; what is on air stays.
    queue.add(100.5, capture: 100.5)
    queue.removeQueued()
    #expect(queue.count == 0)
    #expect(queue.pick(at: 101.5, period: 1 / 60)?.picture == -1)
    queue.setDelay(seconds: 0.2)
    #expect(queue.delaySeconds == 0.2)
  }

  @Test("The queue keeps D plus a spare of pictures")
  func boundedBySpan() {
    var queue = ProgrammePictureQueue<Double>(delaySeconds: 0.5)
    for index in 0 ..< 300 { queue.add(Double(index) / 60, capture: Double(index) / 60) }
    // 0.75 s at 60 fps, give or take the edge.
    #expect(queue.count >= 45 && queue.count <= 47)
  }

  // MARK: - The preview's shared floor

  @Test("An RTSP camera's delay line is sized by the cap, floored by the others and reports itself")
  func rtspDelayLine() throws {
    let coordinator = PlayoutCoordinator()
    coordinator.setCap(milliseconds: 500)
    coordinator.report(450, for: SourceID("other"))
    let source = RTSPFrameSource(
      sourceID: SourceID("camera"),
      displayName: "camera",
      configuration: RTSPSession.Configuration(host: "127.0.0.1", port: 9),
      coordinator: coordinator
    )
    source.handle(.playing(description: SourceSoundTimelineTests.sdp(cname: "phone"), channels: .init(video: 0, audio: 2)))
    // One whole HEVC picture: a single NAL in one packet, marker set.
    var bytes: [UInt8] = [ 0x80, 0xE0, 0, 1, 0, 0, 0x0B, 0xB8, 0, 0, 0, 7 ]
    bytes += [ 0x02, 0x01 ] + [UInt8](repeating: 0xAB, count: 32)
    let packet = try #require(RTPPacket.parse(Data(bytes)))
    source.handle(.packet(channel: 0, packet: packet))
    #expect(source.receiveStats.captured == 1)
    source.drain()
    #expect(coordinator.perSourceMilliseconds[SourceID("camera")] != nil)
  }

  @Test("A camera's floor is the others' requirement, and falls when the slow camera recovers")
  func previewFloorFalls() {
    let coordinator = PlayoutCoordinator()
    let fast = SourceID("fast")
    let slow = SourceID("slow")
    coordinator.report(150, for: fast)
    coordinator.report(1_400, for: slow)
    #expect(coordinator.floorMilliseconds(excluding: fast) == 1_400)
    // Its own requirement never comes back to it as a floor.
    #expect(coordinator.floorMilliseconds(excluding: slow) == 150)
    // The slow camera recovers: its next report is what it now needs, and the floor follows it.
    coordinator.report(200, for: slow)
    #expect(coordinator.floorMilliseconds(excluding: fast) == 200)
    #expect(coordinator.programMilliseconds == 200)
    coordinator.setCap(milliseconds: 500)
    coordinator.report(1_400, for: slow)
    #expect(coordinator.floorMilliseconds(excluding: fast) == 500)
  }

  @Test("A camera reports what it needs itself, not the floor it was given")
  func requirementIgnoresFloor() {
    var controller = PlayoutController(seedMilliseconds: 300)
    #expect(controller.requirementMilliseconds == 300)
    // Arrivals spread by 100 ms.
    for index in 0 ..< 100 {
      let now = 10 + Double(index) * 0.02
      controller.note(lateness: index % 10 == 0 ? 0.1 : 0, at: now)
      controller.advance(to: now)
    }
    controller.setFloor(milliseconds: 1_500)
    controller.advance(to: 12.1)
    #expect(abs(controller.requirementMilliseconds - 150) < 0.001)
    #expect(controller.bufferMilliseconds > 150)
    controller.setCeiling(milliseconds: 120)
    #expect(controller.requirementMilliseconds == 120)
  }
}
