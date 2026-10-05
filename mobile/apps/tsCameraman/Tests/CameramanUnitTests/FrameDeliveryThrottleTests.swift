import CameramanCore
import CameramanRTSP
import CoreMedia
import Foundation
import Testing

@testable import CameramanUI

/// The test throttle: which captured frames reach the encoder, at what rate and how unevenly, and
/// that setting it over the parameter port changes nothing else about the stream.
@Suite("Frame delivery throttle")
struct FrameDeliveryThrottleTests {
  /// SplitMix64, so a run is the same every time.
  final class Seeded: @unchecked Sendable {
    private var state: UInt64
    private let lock = NSLock()

    init(_ seed: UInt64) { state = seed }

    func next() -> Double {
      lock.withLock {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / Double(UInt64(1) << 53)
      }
    }
  }

  static func throttle(seed: UInt64 = 7) -> FrameDeliveryThrottle {
    let random = Seeded(seed)
    return FrameDeliveryThrottle { random.next() }
  }

  /// Capture times of a camera running at `fps` for `seconds`, from `start`, with a little of the
  /// wobble real capture times have.
  static func captureTimes(fps: Double = 60, seconds: Double, start: Double = 1000) -> [Double] {
    let count = Int(seconds * fps)
    return (0 ..< count).map { index in
      start + Double(index) / fps + (index % 3 == 0 ? 0.0004 : -0.0003)
    }
  }

  static func kept(_ throttle: FrameDeliveryThrottle, _ times: [Double]) -> [Double] {
    times.filter { throttle.shouldDeliver(captureTime: $0) }
  }

  @Test("A 60 fps capture throttled to 24 delivers 24 ± 1 a second, unevenly, at its own capture times")
  func steadyRate() {
    let throttle = Self.throttle()
    throttle.configure(FrameDelivery(frameRate: 24))
    let times = Self.captureTimes(seconds: 60)
    let kept = Self.kept(throttle, times)

    // Every kept frame is a captured frame, at exactly its capture time.
    #expect(Set(kept).isSubset(of: Set(times)))
    #expect(kept.first == times.first)

    // 24 ± 1 in every ten-second stretch.
    for window in 0 ..< 6 {
      let start = times[0] + Double(window) * 10
      let count = kept.filter { $0 >= start && $0 < start + 10 }.count
      #expect(abs(Double(count) / 10 - 24) <= 1, "window \(window): \(count) frames")
    }

    // Uneven: intervals spread across ±30% of 1/24, plus at most one capture interval of rounding.
    let intervals = zip(kept.dropFirst(), kept).map { $0 - $1 }
    let mean = 1.0 / 24
    #expect(intervals.allSatisfy { $0 >= mean * 0.7 - 1.0 / 60 && $0 <= mean * 1.3 + 1.0 / 60 })
    #expect(intervals.contains { $0 < mean * 0.85 })
    #expect(intervals.contains { $0 > mean * 1.15 })
    let average = intervals.reduce(0, +) / Double(intervals.count)
    let spread = (intervals.map { ($0 - average) * ($0 - average) }.reduce(0, +) / Double(intervals.count)).squareRoot()
    #expect(spread / average > 0.1)

    let measured = throttle.deliveredFrameRate ?? 0
    #expect(abs(measured - 24) <= 2, "measured \(measured)")
  }

  @Test("A swing 24:60:20 follows the ramp up and back down, and restarts at low when configured")
  func swingFollowsTheRamp() {
    let throttle = Self.throttle(seed: 11)
    let swing = FrameRateSwing(low: 24, high: 60, periodSeconds: 20)
    throttle.configure(FrameDelivery(swing: swing))
    let times = Self.captureTimes(seconds: 40)
    let kept = Self.kept(throttle, times)
    let start = times[0]

    // Two-second windows where the target stays below what a 60 fps camera can give.
    for centre in stride(from: 2.0, through: 38.0, by: 2.0) {
      let expected = swing.rate(atElapsed: centre)
      guard expected < 50 else { continue }
      let count = kept.filter { $0 >= start + centre - 1 && $0 < start + centre + 1 }.count
      #expect(abs(Double(count) / 2 - expected) <= 4, "at \(centre) s: \(Double(count) / 2) fps, expected \(expected)")
    }
    // Near the top every captured frame is kept.
    let top = kept.filter { $0 >= start + 9.5 && $0 < start + 10.5 }.count
    #expect(top >= 52, "at the peak: \(top)")

    // Configuring again starts the swing over at its low.
    let later = Self.captureTimes(seconds: 2, start: times.last! + 1.0 / 60)
    throttle.configure(FrameDelivery(swing: swing))
    let restarted = Self.kept(throttle, later)
    #expect(abs(Double(restarted.count) / 2 - 25) <= 3, "restarted at \(Double(restarted.count) / 2)")
  }

  @Test("Off delivers every frame, and turning a throttle off restores every frame")
  func offRestoresEveryFrame() {
    let throttle = Self.throttle()
    #expect(throttle.delivery == .off)
    let first = Self.captureTimes(seconds: 2)
    #expect(Self.kept(throttle, first) == first)
    #expect(abs((throttle.deliveredFrameRate ?? 0) - 60) < 1)

    throttle.configure(FrameDelivery(frameRate: 10))
    let second = Self.captureTimes(seconds: 2, start: first.last! + 1.0 / 60)
    #expect(Self.kept(throttle, second).count < 30)

    throttle.configure(.off)
    let third = Self.captureTimes(seconds: 2, start: second.last! + 1.0 / 60)
    #expect(Self.kept(throttle, third) == third)
  }

  @Test("A rate above what the camera captures keeps every frame, with no burst after")
  func rateAboveCaptureKeepsEverything() {
    let throttle = Self.throttle()
    throttle.configure(FrameDelivery(frameRate: 120))
    let times = Self.captureTimes(fps: 30, seconds: 4)
    #expect(Self.kept(throttle, times) == times)
  }

  @Test("A capture clock that steps back starts the throttle over")
  func clockStepBackResets() {
    let throttle = Self.throttle()
    throttle.configure(FrameDelivery(frameRate: 2))
    #expect(throttle.shouldDeliver(captureTime: 500))
    #expect(!throttle.shouldDeliver(captureTime: 500.1))
    #expect(throttle.deliveredFrameRate == nil, "one frame is no rate")
    // A new session's clock, far behind: the first frame is kept rather than waiting for 500.5.
    #expect(throttle.shouldDeliver(captureTime: 10))
    #expect(throttle.deliveredFrameRate == nil, "the old session's frames are not counted")
  }

  @Test("The default generator varies intervals too")
  func defaultGenerator() {
    let throttle = FrameDeliveryThrottle()
    throttle.configure(FrameDelivery(frameRate: 24))
    let kept = Self.kept(throttle, Self.captureTimes(seconds: 10))
    #expect(abs(Double(kept.count) / 10 - 24) <= 1.5)
  }

  @Test("A swing parses low:high:period, prints canonically, and is a triangle starting at low")
  func swingParsing() throws {
    let swing = try #require(FrameRateSwing(text: " 24 : 60 : 20 "))
    #expect(swing == FrameRateSwing(low: 24, high: 60, periodSeconds: 20))
    #expect(swing.text == "24:60:20")
    #expect(FrameRateSwing(text: "29.97:59.94:7.5")?.text == "29.97:59.94:7.5")
    #expect(FrameRateSwing(text: "30:30:10") != nil, "a flat swing is a steady rate")

    for bad in [ "", "24", "24:60", "24:60:20:1", "60:24:20", "0:60:20", "24:300:20", "24:60:0", "24:60:-5", "a:b:c", "24:60:inf" ] {
      #expect(FrameRateSwing(text: bad) == nil, "\(bad)")
    }

    #expect(swing.rate(atElapsed: 0) == 24)
    #expect(swing.rate(atElapsed: 5) == 42)
    #expect(swing.rate(atElapsed: 10) == 60)
    #expect(swing.rate(atElapsed: 15) == 42)
    #expect(swing.rate(atElapsed: 20) == 24)
    #expect(swing.rate(atElapsed: 25) == 42)
    #expect(swing.rate(atElapsed: -5) == 42, "before the anchor reads as the previous period")
  }

  @Test("A swing wins over a steady rate, and nothing set is off")
  func targetRate() {
    #expect(FrameDelivery.off.isOff)
    #expect(FrameDelivery.off.targetRate(atElapsed: 3) == nil)
    #expect(FrameDelivery(frameRate: 24).targetRate(atElapsed: 3) == 24)
    let both = FrameDelivery(frameRate: 24, swing: FrameRateSwing(low: 30, high: 60, periodSeconds: 10))
    #expect(!both.isOff)
    #expect(both.targetRate(atElapsed: 0) == 30)
    #expect(FrameDelivery.accepts(rate: 1))
    #expect(FrameDelivery.accepts(rate: 240))
    #expect(!FrameDelivery.accepts(rate: 0.5))
    #expect(!FrameDelivery.accepts(rate: .nan))
  }

  // MARK: - Over the parameter port

  @Test("SET test.deliveredFrameRate throttles without touching settings, the format or the session; GET reports it")
  @MainActor
  func parameterPortDrivesTheThrottle() throws {
    let environment = AppEnvironment(broadcastStore: InMemorySettingsStore())
    #expect(environment.frameThrottle.delivery == .off, "off at launch")
    let before = environment.settings

    let set = environment.handleParameters(RTSPResponder.ParameterRequest(
      method: .set,
      body: "test.deliveredFrameRate: 24\r\n"
    ))
    #expect(set.statusCode == 200)
    #expect(set.body == "test.deliveredFrameRate: 24\r\n")
    #expect(environment.frameThrottle.delivery == FrameDelivery(frameRate: 24))
    #expect(environment.settings == before, "format, rate, codec and sound are untouched")

    let swing = environment.handleParameters(RTSPResponder.ParameterRequest(
      method: .set,
      body: "test.deliveredFrameRate: 0\r\ntest.deliveredFrameRateSwing: 24:60:20\r\n"
    ))
    #expect(swing.statusCode == 200)
    #expect(environment.frameThrottle.delivery == FrameDelivery(swing: FrameRateSwing(low: 24, high: 60, periodSeconds: 20)))

    for time in Self.captureTimes(seconds: 1) { _ = environment.frameThrottle.shouldDeliver(captureTime: time) }
    let get = environment.handleParameters(RTSPResponder.ParameterRequest(
      method: .get,
      body: "test.deliveredFrameRate\r\ntest.deliveredFrameRateSwing\r\ntest.deliveredFrameRate.actual\r\n"
    ))
    #expect(get.statusCode == 200)
    let reply = try CameraParameterSet.decode(get.body).get()
    #expect(reply["test.deliveredFrameRate"] == "0")
    #expect(reply["test.deliveredFrameRateSwing"] == "24:60:20")
    let actual = try #require(reply["test.deliveredFrameRate.actual"].flatMap(Double.init))
    #expect(actual > 20 && actual < 45, "\(actual)")

    let dump = environment.stateDump.frameDelivery
    #expect(dump.frameRate == 0)
    #expect(dump.swing == "24:60:20")
    #expect(dump.deliveredFrameRate != nil)

    let off = environment.handleParameters(RTSPResponder.ParameterRequest(
      method: .set,
      body: "test.deliveredFrameRateSwing:\r\n"
    ))
    #expect(off.statusCode == 200)
    #expect(environment.frameThrottle.delivery == .off)
    #expect(environment.settings == before)

    let refused = environment.handleParameters(RTSPResponder.ParameterRequest(
      method: .set,
      body: "test.deliveredFrameRate.actual: 5\r\n"
    ))
    #expect(refused.statusCode == 458)
  }

  @Test("A new launch starts with the throttle off")
  @MainActor
  func offAtLaunch() throws {
    let first = AppEnvironment(broadcastStore: InMemorySettingsStore())
    first.frameThrottle.configure(FrameDelivery(frameRate: 12))
    let second = AppEnvironment(broadcastStore: InMemorySettingsStore())
    #expect(second.frameThrottle.delivery == .off)
    #expect(second.stateDump.frameDelivery == AppEnvironment.FrameDeliveryDump(frameRate: 0, swing: nil, deliveredFrameRate: nil))
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(second.stateDump)) as? [String: Any]
    let delivery = json?["frameDelivery"] as? [String: Any]
    #expect(delivery?["frameRate"] as? Double == 0)
  }

  @Test("The capture path asks the throttle with each frame's own presentation time")
  func capturePathUsesPresentationTime() throws {
    let throttle = Self.throttle()
    throttle.configure(FrameDelivery(frameRate: 1))
    #expect(AppEnvironment.delivers(try Self.sample(at: 100), through: throttle))
    #expect(!AppEnvironment.delivers(try Self.sample(at: 100.5), through: throttle))
    #expect(AppEnvironment.delivers(try Self.sample(at: 101.4), through: throttle))
  }

  static func sample(at seconds: Double) throws -> CMSampleBuffer {
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: 60),
      presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000),
      decodeTimeStamp: .invalid
    )
    var sample: CMSampleBuffer?
    #expect(CMSampleBufferCreate(
      allocator: kCFAllocatorDefault,
      dataBuffer: nil,
      dataReady: true,
      makeDataReadyCallback: nil,
      refcon: nil,
      formatDescription: nil,
      sampleCount: 0,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 0,
      sampleSizeArray: nil,
      sampleBufferOut: &sample
    ) == noErr)
    return try #require(sample)
  }
}
