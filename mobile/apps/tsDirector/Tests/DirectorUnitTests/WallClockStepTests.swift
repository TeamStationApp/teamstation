import CoreMedia
import DirectorCore
@testable import DirectorMedia
@testable import DirectorPipeline
@testable import DirectorRTSP
import DirectorSources
import Foundation
import Testing

/// The live path times everything on the steady wall clock, so a step of the iPad's own clock moves
/// nothing. On the bench an NTP step of +102 ms re-epoched the stream's sound (an 80 ms gap in its
/// stamps, 20 ms of silence) and stretched one picture by the step.
@Suite("Wall clock steps")
struct WallClockStepTests {
  static let steps: [Double] = [ 0.1, -0.1, 1, -1 ]

  /// A device whose wall clock steps by `step` once uptime passes `at`, and the steady clock on it.
  final class Device: @unchecked Sendable {
    private let lock = NSLock()
    private var up: Double
    let start: Double
    let step: Double
    let at: Double
    lazy var steady = SteadyWall(wall: { [unowned self] in self.wall }, uptime: { [unowned self] in self.uptime })
    lazy var clock = SystemClock(steady: steady)

    init(wall start: Double, uptime: Double, step: Double, at: Double) {
      self.start = start - uptime
      up = uptime
      self.step = step
      self.at = at
    }

    var uptime: Double { lock.withLock { up } }
    /// The device's own wall clock, which steps.
    var wall: Double { lock.withLock { start + up + (up >= at ? step : 0) } }
    func advance(by seconds: Double) { lock.withLock { up += seconds } }
  }

  @Test("The steady wall clock counts uptime through a step of the device's clock", arguments: steps)
  func steadyThroughStep(step: Double) {
    let device = Device(wall: 1_800_000_000, uptime: 1_000, step: step, at: 1_010)
    let before = device.clock.now.seconds
    #expect(before == 1_800_000_000)
    device.advance(by: 20)
    #expect(abs(device.wall - (1_800_000_020 + step)) < 1e-6, "the device's own clock stepped")
    #expect(abs(device.clock.now.seconds - 1_800_000_020) < 1e-6)
    #expect(device.steady.offsetSeconds == 1_800_000_000 - 1_000)
  }

  @Test("Across a step the mix's chunks stay contiguous, so the stream's sound keeps its epoch", arguments: steps)
  func mixContiguous(step: Double) {
    let device = Device(wall: 1_800_000_000, uptime: 1_000, step: step, at: 1_001)
    let walls = Walls()
    let mixer = AudioMixer(clock: device.clock, uptime: { device.uptime }, runsTimer: false) { walls.add($0) }
    mixer.start()
    for _ in 0 ..< 100 {
      device.advance(by: 0.02)
      mixer.emitReadyChunks()
    }
    let seen = walls.values
    #expect(seen.count > 90)
    // ProgramStreamer starts a new epoch when a chunk is more than 10 ms from where the last ended.
    for (a, b) in zip(seen, seen.dropFirst()) {
      #expect(abs(b - a - 0.02) < 1e-6, "chunk at \(b) after \(a)")
    }
  }

  @Test("The stream's stamps count uptime through a step, and sound and picture share them", arguments: steps)
  func streamStamps(step: Double) {
    let device = Device(wall: 1_800_000_000, uptime: 1_000, step: step, at: 1_001)
    let telemetry = PipelineTelemetry(clock: device.clock)
    let streamer = ProgramStreamer(telemetry: telemetry, converter: PixelConverter(), clock: device.clock)
    let first = streamer.absoluteNow()
    device.advance(by: 2)
    #expect(abs(streamer.absoluteNow() - first - 2) < 1e-6)
    // The sound's epoch is taken from the mix's chunk on the same clock as the video stamps.
    let epoch = ProgramStreamer.audioEpochMilliseconds(
      inputWall: device.clock.now.seconds - kCFAbsoluteTimeIntervalSince1970,
      startWall: first,
      primingSamples: 0
    )
    #expect(abs(epoch - 2_000) < 0.001)
  }

  @Test("A camera's capture times and the programme tick agree across a step, so the same picture goes out", arguments: steps)
  func picturesThroughStep(step: Double) {
    let device = Device(wall: 1_800_000_000, uptime: 1_000, step: step, at: 1_040)
    var audit = RTPClockAudit()
    var picks: [Double] = []
    // A camera 0.2 s ahead, a report and thirty pictures a second, each arriving 10 ms after capture.
    var queue = ProgrammePictureQueue<Double>(delaySeconds: 0.5)
    for frame in 0 ..< 80 * 30 {
      let elapsed = Double(frame) / 30
      device.advance(by: frame == 0 ? 0 : 1.0 / 30)
      if frame % 30 == 0 {
        audit.note(
          report: Self.report(camera: 1_800_000_000 + elapsed + 0.2, rtp: UInt32(frame) * 3_000),
          arrivalUptime: device.uptime,
          wallClockNow: device.clock.now.date
        )
      }
      if let capture = audit.captureTimeOnLocalClock(rtpTimestamp: UInt32(frame) * 3_000, ssrc: 7) {
        queue.add(elapsed, capture: capture)
      }
      if let entry = queue.pick(at: device.clock.now.seconds, period: 1.0 / 30) { picks.append(entry.picture) }
    }
    // Every tick shows the picture captured D before it, through the step as before it.
    let tail = Array(picks.suffix(30 * 60))
    #expect(zip(tail, tail.dropFirst()).allSatisfy { abs($1 - $0 - 1.0 / 30) < 1e-6 })
    #expect(audit.clockSteps == 0)
    #expect(queue.latePictures == 0)
  }

  static func report(camera unixSeconds: Double, rtp: UInt32) -> RTCPReport {
    let ntpSeconds = unixSeconds + 2_208_988_800
    let whole = UInt64(ntpSeconds)
    let fraction = UInt64((ntpSeconds - Double(whole)) * 4_294_967_296)
    return RTCPReport(senderReports: [
      RTCPReport.SenderReport(ssrc: 7, ntpTimestamp: (whole << 32) | fraction, rtpTimestamp: rtp, packetCount: 1, octetCount: 1)
    ])
  }

  final class Walls: @unchecked Sendable {
    private let lock = NSLock()
    private var collected: [Double] = []
    var values: [Double] { lock.withLock { collected } }
    func add(_ frame: AudioFrame) { lock.withLock { collected.append(frame.wallClock.seconds) } }
  }
}
