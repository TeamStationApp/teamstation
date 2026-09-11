import Foundation
import DirectorPipeline
import Testing

@Suite("Stream frame pacer")
struct StreamFramePacerTests {
  /// Deterministic jitter so a failure reproduces.
  private struct Jitter {
    var state: UInt64 = 0x9E37_79B9_7F4A_7C15
    mutating func next() -> Double {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double(state >> 11) / Double(1 << 53) * 2 - 1
    }
  }

  private func admitted(rate: Double, seconds: Double, jitterMs: Double, streamRate: Int) -> [Double] {
    var pacer = StreamFramePacer(frameRate: streamRate)
    var jitter = Jitter()
    var times: [Double] = []
    let count = Int(rate * seconds)
    for index in 0 ..< count {
      let now = 1_000 + Double(index) / rate + jitter.next() * jitterMs / 1_000
      if pacer.admit(now: now) { times.append(now) }
    }
    return times
  }

  /// A 60 fps camera into a 30 fps stream would otherwise double the encoder's load.
  @Test("A jittery 60 fps programme feeds a 30 fps stream a steady 30")
  func sixtyBecomesThirty() {
    let times = admitted(rate: 60, seconds: 10, jitterMs: 3, streamRate: 30)
    #expect(abs(times.count - 300) <= 2, "admitted \(times.count) of 600 frames in 10 s")
    let gaps = zip(times.dropFirst(), times).map { $0 - $1 }
    #expect(gaps.allSatisfy { $0 > 0.025 && $0 < 0.042 }, "gaps from \(gaps.min() ?? 0) to \(gaps.max() ?? 0)")
  }

  @Test("A programme already at the stream rate passes every frame")
  func thirtyPassesEverything() {
    let times = admitted(rate: 30, seconds: 10, jitterMs: 3, streamRate: 30)
    #expect(times.count == 300)
  }

  @Test("A slower programme is never thinned further")
  func twentyFourPassesEverything() {
    let times = admitted(rate: 24, seconds: 10, jitterMs: 2, streamRate: 30)
    #expect(times.count == 240)
  }

  @Test("After a stall the cadence restarts instead of bursting to catch up")
  func stallDoesNotBurst() {
    var pacer = StreamFramePacer(frameRate: 30)
    for index in 0 ..< 60 { _ = pacer.admit(now: 1_000 + Double(index) / 60) }
    // Nothing for two seconds, then 60 fps again: the first frames back must still be paced.
    var burst = 0
    for index in 0 ..< 6 where pacer.admit(now: 1_003 + Double(index) / 60) { burst += 1 }
    #expect(burst <= 3, "admitted \(burst) of the first 6 frames after a stall")
  }
}
