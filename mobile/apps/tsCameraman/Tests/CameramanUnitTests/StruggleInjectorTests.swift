import CameramanCore
import CameramanRTSP
import CoreMedia
import Foundation
import Testing

@testable import CameramanUI

/// The struggling-phone injection (U-T3): a healthy phone made to starve like a hot one. Sound lost
/// before the encoder in bursts, both streams held and released in a burst, and the picture rate
/// falling irregularly. Seeded, so a run can be replayed exactly.
@Suite("Struggling phone")
struct StruggleInjectorTests {
  static let struggle = Struggle(mic: 0.3, hold: 0.2, slow: 0.4, seed: 42)

  /// Stretches of `seconds` of sound, 20 ms each, from `start`, through `injector`; the kept start times.
  static func keptSound(_ injector: StruggleInjector, seconds: Double, start: Double = 500) -> [Double] {
    stride(from: start, to: start + seconds, by: 0.02).filter {
      injector.keepsSound(captureTime: $0, duration: 0.02)
    }
  }

  @Test("It parses mic:hold:slow[:seed], picks and reports a seed when none is given")
  func parsing() throws {
    let given = try #require(Struggle(text: "0.3:0.2:0.40:42"))
    #expect(given == Self.struggle)
    #expect(given.text == "0.3:0.2:0.4:42")
    let picked = try #require(Struggle(text: " 0.1 :0:0", randomSeed: { 9 }))
    #expect(picked.text == "0.1:0:0:9")
    #expect(Struggle(text: "0.1:0:0") != nil)
    #expect(Struggle(text: "0:0:0:1")?.isOff == true)
    #expect(picked.isOff == false)
    for bad in [ "0.1:0.1", "0.6:0:0", "0:0.95:0", "0:0:0.99", "-0.1:0:0", "x:0:0", "0:0:0:x", "0:0:0:1:2" ] {
      #expect(Struggle(text: bad) == nil, "\(bad)")
    }
  }

  @Test("Seed 42 gives the reference windows, the same as the Pixel")
  func referenceWindows() {
    var mic = WindowSchedule(seed: 42 ^ 0x6D69_6300, level: 0.3, window: StruggleInjector.micBurst)
    mic.extend(through: 1.9)
    let expected = [
      0.0507550039774627 ... 0.14469268888014095, 0.7341667420834092 ... 1.1055584468036428,
      1.8284648219572681 ... 1.9539141295388622
    ]
    for (window, reference) in zip(mic.windows, expected) {
      #expect(abs(window.lowerBound - reference.lowerBound) < 1e-12)
      #expect(abs(window.upperBound - reference.upperBound) < 1e-12)
    }
    var hold = WindowSchedule(seed: 42 ^ 0x686F_6C64, level: 0.2, window: StruggleInjector.holdLength)
    #expect(hold.window(at: 7)?.lowerBound == 6.984956325811961)
  }

  @Test("Windows take about their level of the time, within their lengths, starting with a gap; same seed same windows")
  func windows() {
    var schedule = WindowSchedule(seed: 7, level: 0.3, window: 0.3 ... 2)
    schedule.extend(through: 20_000)
    let covered = schedule.windows.map { $0.upperBound - $0.lowerBound }.reduce(0, +)
    let end = schedule.windows.last!.upperBound
    #expect(abs(covered / end - 0.3) < 0.03, "\(covered / end)")
    #expect(schedule.windows.allSatisfy { (0.3 ... 2).contains($0.upperBound - $0.lowerBound) })
    #expect(zip(schedule.windows, schedule.windows.dropFirst()).allSatisfy { $0.upperBound <= $1.lowerBound })
    var again = WindowSchedule(seed: 7, level: 0.3, window: 0.3 ... 2)
    var other = WindowSchedule(seed: 8, level: 0.3, window: 0.3 ... 2)
    let times = stride(from: 0.0, to: 300, by: 0.1)
    let first = times.map { again.window(at: $0) }
    #expect(first == times.map { schedule.window(at: $0) })
    #expect(first != times.map { other.window(at: $0) })
    let window = schedule.windows[3]
    #expect(schedule.window(at: (window.lowerBound + window.upperBound) / 2) == window)
    var none = WindowSchedule(seed: 7, level: 0, window: 0.3 ... 2)
    #expect(none.window(at: 10) == nil)
    none.extend(through: 100)
    #expect(none.windows.isEmpty)
  }

  @Test("Mic loss drops about its level of the sound, in bursts of 20-400 ms, and reports it")
  func micLoss() {
    let injector = StruggleInjector()
    injector.configure(Struggle(mic: 0.3, hold: 0, slow: 0, seed: 42))
    let kept = Self.keptSound(injector, seconds: 1_200)
    let dropped = 60_000 - kept.count
    #expect(abs(Double(dropped) / 60_000 - 0.3) < 0.04, "\(dropped)")
    #expect(abs(injector.summary.droppedSoundSeconds - Double(dropped) * 0.02) < 1e-6)
    // Gaps in what is kept are bursts: none longer than a burst plus a stretch.
    let gaps = zip(kept, kept.dropFirst()).map { $1 - $0 }.filter { $0 > 0.03 }
    #expect(!gaps.isEmpty)
    // Two bursts can run together across a short gap, but most holes are single bursts.
    let single = gaps.filter { $0 <= StruggleInjector.micBurst.upperBound + 0.041 }
    #expect(Double(single.count) / Double(gaps.count) > 0.8)
    #expect(gaps.allSatisfy { $0 < 2 })
    // The same seed drops the same sound, wherever the capture clock starts.
    injector.configure(Struggle(mic: 0.3, hold: 0, slow: 0, seed: 42))
    #expect(abs(Self.keptSound(injector, seconds: 1_200, start: 9_000).count - kept.count) <= 2)
    // Nothing else is touched.
    #expect(injector.keepsFrame(captureTime: 1))
    #expect(injector.holdRelease(now: 1) == nil)
  }

  @Test("Slow windows thin the pictures to one every 50-250 ms; outside them every picture passes")
  func slowPictures() {
    let injector = StruggleInjector()
    injector.configure(Struggle(mic: 0, hold: 0, slow: 0.4, seed: 5))
    let times = FrameDeliveryThrottleTests.captureTimes(seconds: 600)
    let kept = times.filter { injector.keepsFrame(captureTime: $0) }
    let dropped = times.count - kept.count
    #expect(UInt64(dropped) == injector.summary.droppedFrames)
    // About 40% of the time at 4-20 fps instead of 60: roughly a third of the pictures go.
    #expect(Double(dropped) / Double(times.count) > 0.25 && Double(dropped) / Double(times.count) < 0.45)
    let spacings = zip(kept, kept.dropFirst()).map { $1 - $0 }
    #expect(spacings.allSatisfy { $0 <= StruggleInjector.slowSpacing.upperBound + 0.02 })
    #expect(spacings.contains { $0 > 0.1 })
    // Seconds-long runs at full rate exist too.
    #expect(spacings.count > 10_000)
    #expect(injector.keepsSound(captureTime: 1, duration: 1))
  }

  @Test("Holds cover about their level of the time, 0.3-2 s each, and release at their end")
  func holds() throws {
    let injector = StruggleInjector()
    injector.configure(Struggle(mic: 0, hold: 0.2, slow: 0, seed: 11))
    let times = Array(stride(from: 100.0, to: 1_300, by: 0.01))
    let releases = times.map { injector.holdRelease(now: $0) }
    let held = releases.compactMap { $0 }.count
    let share = Double(held) / Double(times.count)
    #expect(abs(share - 0.2) < 0.04, "\(held)")
    for (time, release) in zip(times, releases) {
      if let release { #expect(release > time && release - time <= 2) }
    }
    let holds = injector.summary.holds
    #expect(holds > 100 && holds < 300, "\(holds)")
    // One hold is counted once however many packets fall in it.
    let first = try #require(releases.firstIndex { $0 != nil })
    #expect(releases[first + 1] == releases[first])
    injector.configure(nil)
    #expect(injector.struggle == nil)
    #expect(injector.holdRelease(now: 5) == nil)
    #expect(injector.summary.holds == 0)
    injector.configure(Struggle(mic: 0, hold: 0, slow: 0, seed: 1))
    #expect(injector.struggle == nil)
  }

  @Test("A held delay line keeps both streams in order and releases them in one burst")
  func delayLineHolds() async throws {
    let line = SendDelayLine()
    let start = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    let order = Recorder()
    line.setHoldRelease { now in now < start + 0.3 ? start + 0.3 : nil }
    line.submit { order.note(1) }
    line.submit { order.note(2) }
    #expect(line.summary.held == 2)
    #expect(order.values.isEmpty)
    try await Task.sleep(nanoseconds: 400_000_000)
    // After the hold a packet goes at once, unless something still waits.
    line.submit { order.note(3) }
    try await Task.sleep(nanoseconds: 100_000_000)
    #expect(order.values == [ 1, 2, 3 ])
    line.setHoldRelease(nil)
    line.submit { order.note(4) }
    #expect(order.values == [ 1, 2, 3, 4 ])
  }

  @Test("A send that arrives while a hold's burst is going out waits for the burst")
  func sendDuringBurstKeepsOrder() async throws {
    let line = SendDelayLine()
    let start = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    let order = Recorder()
    line.setHoldRelease { now in now < start + 0.2 ? start + 0.2 : nil }
    for value in 1 ... 3 {
      line.submit {
        Thread.sleep(forTimeInterval: 0.05)
        order.note(value)
      }
    }
    // The burst goes out from 0.2 s and takes 0.15 s; this send lands in the middle of it.
    try await Task.sleep(nanoseconds: 260_000_000)
    line.submit { order.note(4) }
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(order.values == [ 1, 2, 3, 4 ])
  }

  @Test("SET test.struggle starts it, reads back with its seed, leaves the throttle's clock, and clears")
  @MainActor
  func parameterPort() throws {
    let environment = AppEnvironment(broadcastStore: InMemorySettingsStore())
    let before = environment.settings
    _ = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.deliveredFrameRate: 30\r\n"))
    #expect(environment.frameThrottle.shouldDeliver(captureTime: 100))
    let set = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.struggle: 0.3:0.2:0.4:42\r\n"))
    #expect(set.statusCode == 200)
    #expect(set.body == "test.struggle: 0.3:0.2:0.4:42\r\n")
    #expect(environment.struggle.struggle == Self.struggle)
    #expect(environment.frameThrottle.delivery.struggle == Self.struggle)
    #expect(environment.frameThrottle.delivery.frameRate == 30)
    // The throttle kept its clock: the next frame is still a thirtieth of a second after the first.
    #expect(!environment.frameThrottle.shouldDeliver(captureTime: 100.01))
    #expect(environment.settings == before)

    let get = environment.handleParameters(RTSPResponder.ParameterRequest(method: .get, body: "test.struggle\r\n"))
    #expect(get.body == "test.struggle: 0.3:0.2:0.4:42\r\n")
    _ = environment.struggle.keepsSound(captureTime: 1, duration: 0.02)
    let dump = environment.stateDump.frameDelivery
    #expect(dump.struggle == "0.3:0.2:0.4:42")
    #expect(dump.struggleHolds == 0)

    let unseeded = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.struggle: 0.1:0:0\r\n"))
    let seed = try #require(environment.struggle.struggle?.seed)
    #expect(unseeded.body == "test.struggle: 0.1:0:0:\(seed)\r\n")
    let bad = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.struggle: 0.9:0:0\r\n"))
    #expect(bad.statusCode == 400)
    // Changing the rate leaves the struggle running.
    _ = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.deliveredFrameRate: 0\r\n"))
    #expect(environment.struggle.struggle?.seed == seed)
    let off = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.struggle:\r\n"))
    #expect(off.statusCode == 200)
    #expect(environment.struggle.struggle == nil)
    #expect(environment.frameThrottle.delivery == .off)
  }

  @Test("The capture path judges sound and pictures by their own capture times")
  func capturePath() throws {
    let injector = StruggleInjector()
    injector.configure(Struggle(mic: 0.5, hold: 0, slow: 0.95, seed: 3))
    let throttle = FrameDeliveryThrottleTests.throttle()
    let soundKept = try stride(from: 100.0, to: 160, by: 0.02).filter {
      AppEnvironment.keepsSound(try FrameDeliveryThrottleTests.sample(at: $0), through: injector)
    }
    #expect(soundKept.count > 1_000 && soundKept.count < 2_000)
    let picturesKept = try FrameDeliveryThrottleTests.captureTimes(seconds: 60, start: 100).filter {
      AppEnvironment.delivers(try FrameDeliveryThrottleTests.sample(at: $0), through: throttle, struggle: injector)
    }
    #expect(picturesKept.count < 3_600 / 2)
  }
}

private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: [Int] = []
  func note(_ value: Int) { lock.withLock { recorded.append(value) } }
  var values: [Int] { lock.withLock { recorded } }
}
