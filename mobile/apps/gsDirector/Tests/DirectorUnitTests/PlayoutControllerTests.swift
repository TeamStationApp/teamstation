import Foundation
import DirectorCore
import DirectorSources
import Testing

/// The traces below reproduce what these cameras actually do: 30 fps, with one keyframe a second
/// that occupies half the second's uplink, so fifteen frames arrive in a burst behind it.
private enum Trace {
  static let frameInterval = 1.0 / 30

  /// Arrival times for `seconds` of video whose keyframe takes `stall` to transmit.
  ///
  /// Each frame's presentation time is its capture time. The keyframe is captured at the top of the
  /// second and lands `stall` later; the frames captured while it was transmitting queue behind it
  /// and land in a burst, then delivery returns to real time.
  static func arrivals(seconds: Int, stall: Double = 0.5) -> [(presentation: Double, arrival: Double)] {
    var result: [(presentation: Double, arrival: Double)] = []
    for second in 0 ..< seconds {
      for frame in 0 ..< 30 {
        let presentation = Double(second) + Double(frame) * frameInterval
        let arrival: Double
        if frame == 0 {
          arrival = presentation + stall
        } else if presentation < Double(second) + stall {
          // Captured while the keyframe was still going out, so it lands just after it does.
          arrival = Double(second) + stall + Double(frame) * 0.002
        } else {
          arrival = presentation + 0.01
        }
        result.append((presentation, arrival))
      }
    }
    return result
  }
}

@Suite("Playout buffer")
struct PlayoutControllerTests {
  @Test("A keyframe burst is absorbed without a single frame arriving after it was due")
  func absorbsTheBurst() {
    var controller = PlayoutController(seedMilliseconds: 300)
    var late = 0

    // The first second is the seed's to get wrong; sizing has no history yet.
    for (presentation, arrival) in Trace.arrivals(seconds: 12) {
      controller.advance(to: arrival)
      if controller.note(lateness: arrival - presentation, at: arrival), arrival > 1 {
        late += 1
      }
    }

    #expect(late == 0)
    #expect(controller.isConverged(at: 12))
  }

  @Test("It converges on the measured spread rather than on the seed")
  func convergesOnWhatItMeasures() {
    var controller = PlayoutController(seedMilliseconds: 300)
    for (presentation, arrival) in Trace.arrivals(seconds: 30, stall: 0.5) {
      controller.advance(to: arrival)
      controller.note(lateness: arrival - presentation, at: arrival)
    }

    // The trace's worst frame is half a second late against the fastest at 10 ms, so the buffer
    // wanted is that spread plus the margin — and nothing like the second the cameras' own worst
    // window would suggest.
    #expect(controller.bufferMilliseconds > 500)
    #expect(controller.bufferMilliseconds < 600)
  }

  @Test("Ten seconds is enough to be within a frame of the final size")
  func convergesWithinTenSeconds() {
    var controller = PlayoutController(seedMilliseconds: 50)
    var atTenSeconds: Double = 0

    for (presentation, arrival) in Trace.arrivals(seconds: 40) {
      controller.advance(to: arrival)
      controller.note(lateness: arrival - presentation, at: arrival)
      if arrival >= 10, atTenSeconds == 0 { atTenSeconds = controller.bufferMilliseconds }
    }

    #expect(abs(atTenSeconds - controller.bufferMilliseconds) < 33)
  }

  @Test("A stream that quietens down gets its delay back, slowly")
  func shrinksAfterItSettles() {
    var controller = PlayoutController(seedMilliseconds: 300)
    for (presentation, arrival) in Trace.arrivals(seconds: 10) {
      controller.advance(to: arrival)
      controller.note(lateness: arrival - presentation, at: arrival)
    }
    let afterBursts = controller.bufferMilliseconds

    // Same camera, no keyframe stall: every frame now lands 10 ms after its timestamp.
    var now = 10.0
    for frame in 0 ..< (30 * 120) {
      now = 10 + Double(frame) * Trace.frameInterval
      controller.advance(to: now)
      controller.note(lateness: 0.01, at: now)
    }

    #expect(controller.bufferMilliseconds < afterBursts)
    #expect(controller.bufferMilliseconds >= 50)
  }

  @Test("Shrinking waits out the settle period after a late frame")
  func doesNotShrinkStraightAfterALateFrame() {
    var controller = PlayoutController(seedMilliseconds: 100)
    controller.note(lateness: 0.0, at: 0)
    // A frame 400 ms late against a 100 ms buffer: an underrun, and the offset jumps to cover it.
    controller.note(lateness: 0.4, at: 1)
    let jumped = controller.bufferMilliseconds
    #expect(jumped > 400)

    for step in 1 ... 100 {
      let now = 1 + Double(step) * 0.1
      controller.advance(to: now)
      controller.note(lateness: 0.01, at: now)
    }
    // Ten seconds of quiet is inside the settle period, so the buffer is still where the late frame
    // put it.
    #expect(controller.bufferMilliseconds > jumped - 50)
  }

  @Test("Growth is gradual but a late frame is covered at once")
  func growsGraduallyAndJumpsOnUnderrun() {
    var controller = PlayoutController(seedMilliseconds: 100)
    controller.note(lateness: 0, at: 0)
    let seeded = controller.offsetSeconds

    // A frame arriving 90 ms late is still inside the buffer, so the offset eases rather than steps.
    controller.note(lateness: 0.09, at: 0.1)
    controller.advance(to: 0.2)
    #expect(controller.offsetSeconds - seeded < 0.01)

    // One past the buffer is a stall that has already been seen, so it is covered immediately.
    let wasLate = controller.note(lateness: 0.5, at: 0.3)
    #expect(wasLate)
    #expect(controller.offsetSeconds > 0.5)
    #expect(controller.lateFrames == 1)
  }

  @Test("The clocks drifting apart moves the offset, not the buffer")
  func followsClockDrift() {
    var controller = PlayoutController(seedMilliseconds: 200)
    var buffers: [Double] = []

    // 100 ppm, far worse than real hardware: the camera's timestamps fall steadily behind ours.
    for frame in 0 ..< (30 * 600) {
      let now = Double(frame) * Trace.frameInterval
      controller.advance(to: now)
      controller.note(lateness: 0.01 + now * 0.0001, at: now)
      if frame % 3000 == 0 { buffers.append(controller.bufferMilliseconds) }
    }

    // The offset has to track ten minutes of drift, which is 60 ms of it.
    #expect(controller.offsetSeconds > 0.05)
    // The buffer itself must not grow to absorb drift — that would be latency for nothing.
    #expect(buffers.allSatisfy { $0 < 260 })
  }

  @Test("A reconnect keeps the size it learned but starts the measurements again")
  func resetKeepsTheLearnedSize() {
    var controller = PlayoutController(seedMilliseconds: 100)
    for (presentation, arrival) in Trace.arrivals(seconds: 12) {
      controller.advance(to: arrival)
      controller.note(lateness: arrival - presentation, at: arrival)
    }
    let learned = controller.bufferMilliseconds

    let fresh = controller.reset()
    #expect(abs(fresh.seedMilliseconds - learned) < 1)
    #expect(fresh.isConverged(at: 0) == false)
    #expect(fresh.offsetSeconds == 0)
  }

  @Test("The floor holds a quiet camera to the same delay as its noisy neighbour")
  func floorHoldsCamerasTogether() {
    var quiet = PlayoutController(seedMilliseconds: 100)
    for frame in 0 ..< 300 {
      let now = Double(frame) * Trace.frameInterval
      quiet.advance(to: now)
      quiet.note(lateness: 0.01, at: now)
    }
    let alone = quiet.bufferMilliseconds

    quiet.setFloor(milliseconds: 600)
    for frame in 300 ..< 1200 {
      let now = Double(frame) * Trace.frameInterval
      quiet.advance(to: now)
      quiet.note(lateness: 0.01, at: now)
    }

    #expect(alone < 200)
    #expect(quiet.bufferMilliseconds > 590)
  }

  @Test("No camera is held past the maximum, however bad it gets")
  func respectsTheMaximum() {
    var controller = PlayoutController(
      seedMilliseconds: 300,
      limits: .init(maximumMilliseconds: 400)
    )
    controller.note(lateness: 0, at: 0)
    controller.note(lateness: 3.0, at: 1)
    #expect(controller.bufferMilliseconds <= 400)
  }

  @Test("An operator ceiling of 500 ms holds a late burst")
  func operatorCeilingCapsTheBuffer() {
    var controller = PlayoutController(seedMilliseconds: 300)
    controller.note(lateness: 0, at: 0)
    controller.setCeiling(milliseconds: 500)
    controller.note(lateness: 3.0, at: 1)
    #expect(controller.bufferMilliseconds <= 500)
  }
}

@Suite("Playout queue")
struct PlayoutQueueTests {
  @Test("Nothing comes out before it is due")
  func holdsUntilDue() {
    var queue = PlayoutQueue<Int>()
    queue.enqueue(1, due: 1.0)
    queue.enqueue(2, due: 2.0)

    #expect(queue.release(at: 0.5).isEmpty)
    #expect(queue.release(at: 1.0) == [1])
    #expect(queue.count == 1)
    #expect(queue.earliestDue == 2.0)
  }

  @Test("A burst comes out in order, oldest first")
  func releasesInOrder() {
    var queue = PlayoutQueue<Int>()
    for value in 1 ... 5 { queue.enqueue(value, due: Double(value) * 0.1) }
    #expect(queue.release(at: 0.35) == [1, 2, 3])
    #expect(queue.release(at: 10) == [4, 5])
    #expect(queue.isEmpty)
  }

  @Test("Frames that arrive out of order are still released in time order")
  func sortsLateArrivals() {
    var queue = PlayoutQueue<String>()
    queue.enqueue("third", due: 0.3)
    queue.enqueue("first", due: 0.1)
    queue.enqueue("second", due: 0.2)
    #expect(queue.release(at: 1) == ["first", "second", "third"])
  }

  @Test("Frames sharing a due time keep the order they arrived in")
  func stableForEqualDueTimes() {
    var queue = PlayoutQueue<Int>()
    queue.enqueue(1, due: 0.5)
    queue.enqueue(2, due: 0.5)
    queue.enqueue(3, due: 0.5)
    #expect(queue.release(at: 0.5) == [1, 2, 3])
  }
}

@Suite("Playout coordination")
struct PlayoutCoordinatorTests {
  @Test("The camera needing the most sets the delay for all of them")
  func programTakesTheMaximum() {
    let coordinator = PlayoutCoordinator()
    #expect(coordinator.report(250, for: SourceID("a")) == 250)
    #expect(coordinator.report(600, for: SourceID("b")) == 600)
    #expect(coordinator.report(300, for: SourceID("c")) == 600)
    #expect(coordinator.programMilliseconds == 600)
  }

  @Test("A camera leaving gives its delay back")
  func retiringLowersTheProgramDelay() {
    let coordinator = PlayoutCoordinator()
    coordinator.report(250, for: SourceID("a"))
    coordinator.report(600, for: SourceID("b"))
    coordinator.retire(SourceID("b"))
    #expect(coordinator.programMilliseconds == 250)
  }

  @Test("A camera used before starts at the size it learned")
  func seedsFromTheCache() {
    let coordinator = PlayoutCoordinator()
    coordinator.seed(420, for: SourceID("a"))
    #expect(coordinator.seedMilliseconds(for: SourceID("a")) == 420)
    #expect(coordinator.seedMilliseconds(for: SourceID("b")) == nil)
  }

  @Test("An operator cap is the ceiling even when a camera asks for more")
  func capClampsTheProgramDelay() {
    let coordinator = PlayoutCoordinator()
    coordinator.setCap(milliseconds: 500)
    #expect(coordinator.report(250, for: SourceID("a")) == 250)
    #expect(coordinator.report(800, for: SourceID("b")) == 500)
    #expect(coordinator.programMilliseconds == 500)
    coordinator.setCap(milliseconds: nil)
    #expect(coordinator.programMilliseconds == 800)
  }
}
