import CoreMedia
import DirectorCore
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// Each camera's drift loop steers its resampler so the sound follows the camera's clock mapping
/// without steps (U-D3). Each phone's clock runs tens of ppm off the iPad's; two earlier takes
/// lost 44-47 s of programme sound to corrections of exactly that drift made as steps.
@Suite("Sound drift loop")
struct SoundDriftLoopTests {
  static let rate = 48_000.0

  /// Feeds `seconds` of 20 ms buffers from a camera whose clock runs `ppm` fast against ours, each
  /// stamped with its true capture time. Returns the timeline's statistics after each second.
  private func run(ppm: Double, seconds: Double, startingAt start: Double = 100, timeline: SourceSoundTimeline? = nil, offset: (Int) -> Double = { _ in 0 }) -> (SourceSoundTimeline, [SourceSoundTimeline.Statistics]) {
    let clock = FixedClock(start + seconds + 0.5)
    let line = timeline ?? SourceSoundTimeline(clock: clock, uptime: { clock.now.seconds })
    let span = 0.02 / (1 + ppm / 1_000_000)
    var perSecond: [SourceSoundTimeline.Statistics] = []
    let buffers = Int(seconds / 0.02)
    for index in 0 ..< buffers {
      line.append(SourceSoundTimelineTests.Rig.frame(
        at: start + Double(index) * span + offset(index),
        position: Int64(index) * 960,
        frames: 960,
        session: 1,
        isCaptureTime: true
      ))
      if (index + 1) % 50 == 0 { perSecond.append(line.currentStatistics) }
    }
    return (line, perSecond)
  }

  @Test("A camera 50 ppm off converges within 15 s, with no step", arguments: [ 50.0, -50.0 ])
  func converges(ppm: Double) {
    let (_, seconds) = run(ppm: ppm, seconds: 60)
    let settled = seconds[15 ..< 60]
    for stats in settled {
      // Laid down at the camera's rate: -50 ppm of correction for a camera 50 ppm fast.
      #expect(abs(stats.driftPartsPerMillion + ppm) < 5, "\(stats.driftPartsPerMillion) ppm")
      #expect(abs(stats.lastErrorSeconds) < 0.001)
    }
    #expect(seconds.last?.steps == 0)
    #expect(seconds.last?.timelines == 1)
    // Never further off than a fraction of a millisecond, even before it converged.
    #expect(seconds.allSatisfy { abs($0.lastErrorSeconds) < 0.002 })
  }

  @Test("The correction is clamped at 500 ppm either way")
  func clamped() {
    let (_, fast) = run(ppm: 2_000, seconds: 20)
    #expect(fast.last?.driftPartsPerMillion == -500)
    let (_, slow) = run(ppm: -2_000, seconds: 20)
    #expect(slow.last?.driftPartsPerMillion == 500)
  }

  @Test("A step resets the loop, which converges again from there")
  func resetAfterStep() {
    // 50 ppm fast, and from 30 s on the mapping is 150 ms later: one step at 31 s.
    let (line, seconds) = run(ppm: 50, seconds: 60) { index in index >= 1_500 ? 0.15 : 0 }
    #expect(line.currentStatistics.steps == 1)
    #expect(abs(seconds[29].driftPartsPerMillion + 50) < 5)
    // Just after the step the loop starts again from nothing...
    #expect(abs(seconds[31].driftPartsPerMillion) < 30)
    // ...and settles again.
    #expect(abs(seconds[59].driftPartsPerMillion + 50) < 5)
  }

  @Test("A resampled tone stays whole: no holes, no clicks, every sample in place")
  func resampledToneIsWhole() {
    let (line, _) = run(ppm: 400, seconds: 20)
    var reader = SourceSoundTimeline.Reader(id: 1)
    var mix = [Int32](repeating: 0, count: 48_000 * 2)
    let from = Int64((110 * Self.rate).rounded())
    line.read(&reader, at: from, count: 48_000, gain: 1, reserveFrames: 0, into: &mix)
    let left = stride(from: 0, to: mix.count, by: 2).map { mix[$0] }
    // A constant tone interpolates to itself: past the fade in, every sample is the tone.
    #expect(left[720...].allSatisfy { $0 == Int32(SourceSoundTimelineTests.level) })
  }

  @Test("Sound placed by arrival does not drive the loop")
  func arrivalDoesNotSteer() {
    let clock = FixedClock(200)
    let line = SourceSoundTimeline(clock: clock, uptime: { clock.now.seconds })
    for index in 0 ..< 1_000 {
      line.append(SourceSoundTimelineTests.Rig.frame(
        at: 100 + Double(index) * 0.02 + (index % 2 == 0 ? 0.03 : -0.03),
        position: Int64(index) * 960,
        frames: 960,
        session: 1
      ))
    }
    #expect(line.currentStatistics.driftPartsPerMillion == 0)
  }

  @Test("A moment's jump in the mapping does not throw the correction about")
  func spikeIgnored() {
    var loop = DriftLoop()
    // Two seconds steady, then one report moving the mapping by -72 ms for nine tenths of a second.
    for index in 0 ..< 300 {
      let error = (100 ..< 145).contains(index) ? -0.072 : 0
      loop.update(errorSeconds: error, over: 0.02)
      #expect(abs(loop.correction) < 1e-9, "\(loop.correction) at \(index)")
    }
  }

  @Test("The loop's arithmetic: proportional plus integral on a smoothed error, clamped")
  func loopArithmetic() {
    var loop = DriftLoop()
    loop.update(errorSeconds: 0.01, over: 0)
    #expect(loop.correction == 0)
    loop.update(errorSeconds: 0.001, over: 0.25)
    // Smoothed error 0.0005; P = 2 * 0.9 * 0.3 * 0.0005, I = 0.09 * 0.0005 * 0.25.
    #expect(abs(loop.correction - (0.00027 + 0.000_011_25)) < 1e-12)
    #expect(loop.ratio == 1 + loop.correction)
    loop.update(errorSeconds: 1, over: 10)
    #expect(loop.correction == SourceSoundTimeline.driftLimit)
  }
}
