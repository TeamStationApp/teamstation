import CNDI
import DirectorCore
@testable import DirectorNDI
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// NDI sound is placed by its NDI timestamp on the same per-source timeline as a camera's (U-D5).
/// It used to be placed where it arrived, so any NDI source carrying the game's sound would have
/// taken its network jitter straight into the mix.
@Suite("NDI sound placement")
struct NDISoundPlacementTests {
  private func ticks(_ seconds: Double) -> Int64 { Int64((seconds * NDIReceiveClock.ticksPerSecond).rounded()) }

  private func video(timestamp: Int64) -> NDIlib_video_frame_v2_t {
    var frame = NDIlib_video_frame_v2_t()
    frame.xres = 1_920
    frame.yres = 1_080
    frame.frame_rate_N = 60
    frame.frame_rate_D = 1
    frame.timestamp = timestamp
    return frame
  }

  @Test("Sound is placed at its timestamp on the pictures' clock offset, however late it arrives")
  func placedByTimestamp() {
    let wall = FixedClock(1_800_000_000)
    let clock = NDIReceiveClock(clock: wall)
    // The sender's clock runs 2 s ahead; a picture arriving 10 ms after capture measures that.
    wall.set(1_800_000_000.01)
    _ = clock.timing(for: video(timestamp: ticks(1_800_000_002)))
    // Sound captured at our 1,800,000,000.5 arrives 180 ms later; then another 40 ms after that.
    wall.set(1_800_000_000.68)
    let first = clock.audioCaptureSeconds(timestamp: ticks(1_800_000_002.5), sampleIndex: 0, sampleRate: 48_000)
    wall.set(1_800_000_000.72)
    let second = clock.audioCaptureSeconds(timestamp: ticks(1_800_000_002.52), sampleIndex: 960, sampleRate: 48_000)
    // Placed where the pictures' offset puts them, 10 ms of transit included, not where they arrived.
    #expect(abs(first - 1_800_000_000.51) < 0.000_01)
    #expect(abs(second - first - 0.02) < 0.000_01)
  }

  @Test("Before any picture, a buffer's own observation stands in for the offset")
  func ownObservationFirst() {
    let wall = FixedClock(1_800_000_000.05)
    let clock = NDIReceiveClock(clock: wall)
    let capture = clock.audioCaptureSeconds(timestamp: ticks(1_800_000_002), sampleIndex: 0, sampleRate: 48_000)
    #expect(abs(capture - 1_800_000_000.05) < 0.000_01)
  }

  @Test("No timestamp, or a nonsense one: placed by count against the least-delayed arrival")
  func missingTimestampFallsBack() {
    let wall = FixedClock(500)
    let clock = NDIReceiveClock(clock: wall)
    // Twenty-millisecond buffers arriving 0-80 ms late; the least-delayed sets the placement.
    let lateness = [0.08, 0.03, 0.0, 0.05, 0.07, 0.02]
    var placed: [Double] = []
    for (index, late) in lateness.enumerated() {
      wall.set(500 + Double(index) * 0.02 + late)
      let stamp: Int64 = index % 2 == 0 ? NDIlib_recv_timestamp_undefined : 0
      placed.append(clock.audioCaptureSeconds(timestamp: stamp, sampleIndex: Int64(index) * 960, sampleRate: 48_000))
    }
    // From the third buffer on, every one sits exactly 20 ms after the last: jitter-free.
    for index in 3 ..< placed.count {
      #expect(abs(placed[index] - (500 + Double(index) * 0.02)) < 0.000_01)
    }
    // A sender with an unset clock (1970) is not believed either.
    wall.set(1_800_000_000)
    let unset = clock.audioCaptureSeconds(timestamp: ticks(10), sampleIndex: 0, sampleRate: 48_000)
    #expect(abs(unset - 1_800_000_000) < 0.000_1)
    clock.reset()
    wall.set(700)
    #expect(abs(clock.audioCaptureSeconds(timestamp: 0, sampleIndex: 48_000, sampleRate: 48_000) - 700) < 0.000_01)
  }

  @Test("A sender clock that steps back is followed after ten seconds, sound and pictures alike")
  func senderClockStep() {
    let wall = FixedClock(1_800_000_000)
    let clock = NDIReceiveClock(clock: wall)
    // A sender 2 s ahead, a picture a second for a minute, then its clock steps back 300 ms.
    for second in 0 ..< 80 {
      let at = 1_800_000_000 + Double(second) + 0.01
      wall.set(at)
      let sender = at - 0.01 + (second < 60 ? 2 : 1.7)
      _ = clock.timing(for: video(timestamp: ticks(sender)))
    }
    #expect(clock.clockSteps == 1)
    wall.set(1_800_000_080)
    let capture = clock.audioCaptureSeconds(timestamp: ticks(1_800_000_079.7 + 1.7), sampleIndex: 0, sampleRate: 48_000)
    #expect(abs(capture - 1_800_000_079.71) < 0.000_1)
    clock.reset()
    #expect(clock.clockSteps == 1)
  }

  @Test("An NDI source hands its sound on stamped with its capture time and sample position")
  func sourceStampsSound() throws {
    let wall = FixedClock(1_800_000_000.2)
    let coordinator = PlayoutCoordinator()
    let source = NDIFrameSource(
      sourceID: SourceID("cosmo"),
      displayName: "Home",
      ndiName: "NDI HX3_A_000001",
      coordinator: coordinator,
      clock: wall
    )
    let received = SoundCollector()
    source.installSinks(FrameSinks(recordingAudio: { received.add($0) }))
    var storage = [Float](repeating: 0.25, count: 960)
    try storage.withUnsafeMutableBytes { raw in
      var frame = NDIlib_audio_frame_v3_t()
      frame.sample_rate = 48_000
      frame.no_channels = 1
      frame.no_samples = 960
      frame.FourCC = NDIlib_FourCC_audio_type_FLTP
      frame.channel_stride_in_bytes = Int32(960 * MemoryLayout<Float>.size)
      frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
      frame.timestamp = ticks(1_800_000_000.1)
      source.handle(audio: frame)
      // The next frame, captured 20 ms later, arrives 30 ms later.
      wall.set(1_800_000_000.23)
      frame.timestamp = ticks(1_800_000_000.12)
      source.handle(audio: frame)
      // A frame the validator refuses goes nowhere.
      frame.no_channels = 0
      source.handle(audio: frame)
      let frames = received.frames
      try #require(frames.count == 2)
      #expect(frames[0].isCaptureTime)
      #expect(frames[0].sourceSamplePosition == 0)
      #expect(frames[1].sourceSamplePosition == 960)
      // The least-delayed observation is the offset: placed where the first arrived, then 20 ms on.
      #expect(abs(frames[0].wallClock.seconds - 1_800_000_000.2) < 0.000_01)
      #expect(abs(frames[1].wallClock.seconds - frames[0].wallClock.seconds - 0.02) < 0.000_01)
    }
    // Its delay line takes the other cameras' requirement as its floor and reports its own.
    coordinator.report(400, for: SourceID("other"))
    source.drain()
    #expect(coordinator.perSourceMilliseconds[SourceID("cosmo")] != nil)
    #expect(source.receiveStats.cameraClockSteps == 0)
  }

  @Test("On the timeline, NDI sound placed at its timestamp plays at timestamp plus D")
  func onTheTimelineAtTimestampPlusD() {
    let wall = FixedClock(1_000)
    let uptime: @Sendable () -> Double = { wall.now.seconds }
    let timelines = SourceSoundTimelines(clock: wall, uptime: uptime)
    let live = SourceSoundTimelineTests.Collected()
    let mixer = AudioMixer(clock: wall, readLagSeconds: 0.5, uptime: uptime, runsTimer: false, timelines: timelines) { live.add($0) }
    mixer.start()
    mixer.setContributors([ SourceID("camera") ])
    for index in 0 ..< 50 {
      // Captured from 1,000.2; delivered in jittery clumps.
      wall.set(1_000.2 + Double(index) * 0.02 + (index % 5 == 0 ? 0.06 : 0))
      timelines.append(SourceSoundTimelineTests.Rig.frame(
        at: 1_000.2 + Double(index) * 0.02,
        position: Int64(index) * 960,
        frames: 960,
        session: 0,
        isCaptureTime: true
      ))
      mixer.emitReadyChunks()
    }
    wall.set(1_003)
    mixer.emitReadyChunks()
    #expect(live.loudWalls.first == 1_000.7)
    #expect(live.loudWalls.count == 50)
    #expect(mixer.currentStatistics.lateBuffers == 0)
  }
}

private final class SoundCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: [AudioFrame] = []
  func add(_ frame: AudioFrame) {
    lock.lock()
    stored.append(frame)
    lock.unlock()
  }
  var frames: [AudioFrame] {
    lock.lock()
    defer { lock.unlock() }
    return stored
  }
}
