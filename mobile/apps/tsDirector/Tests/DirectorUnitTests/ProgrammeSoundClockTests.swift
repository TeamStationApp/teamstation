import CoreMedia
import DirectorCore
@testable import DirectorMedia
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// The programme's sound runs on its own sample counter from go-live (U-D1). One game's live
/// stream went out with no sound track for its first 1,110 s because the mix waited for the
/// first camera to speak before it emitted anything.
@Suite("Programme sound clock")
struct ProgrammeSoundClockTests {
  // MARK: - The counter

  @Test("A started mix emits silent chunks with no source at all")
  func silenceWithNoSources() {
    let rig = Rig(wall: 1_000, uptime: 50)
    rig.mixer.start()
    rig.advance(by: 1)
    rig.mixer.emitReadyChunks()

    // One second less the live mix's 20 ms delay: 49 whole chunks of 960 samples.
    #expect(rig.collected.count == 49)
    #expect(rig.collected.loudIndices.isEmpty)
    #expect(rig.collected.walls.first == 1_000)
    #expect(rig.collected.isContiguous)
    #expect(rig.collected.presentationSamples.first == 48_000_000)
    #expect(rig.mixer.currentStatistics.emittedSamples == 49 * 960)
  }

  @Test("A source that speaks later is heard at its due sample, after silence")
  func laterSourceAtItsDueSample() {
    let rig = Rig(wall: 1_000, uptime: 50)
    rig.mixer.start()
    rig.advance(by: 2)
    rig.mixer.emitReadyChunks()
    rig.mixer.append(Self.frame(Self.tone(8_000, seconds: 0.1), at: 1_002))
    rig.advance(by: 0.5)
    rig.mixer.emitReadyChunks()

    // Sample 96,000 is chunk 100; the tone fills five chunks.
    #expect(rig.collected.loudIndices == [ 100, 101, 102, 103, 104 ])
    #expect(rig.collected.walls[100] == 1_002)
    #expect(rig.collected.isContiguous)
    #expect(rig.mixer.currentStatistics.lateBuffers == 0)
  }

  @Test("Stopping resets the counter and the next start begins again at sample 0")
  func stopStartResets() {
    let rig = Rig(wall: 1_000, uptime: 50)
    rig.mixer.start()
    rig.advance(by: 1)
    rig.mixer.emitReadyChunks()
    #expect(rig.mixer.isRunning)

    rig.mixer.stop()
    #expect(rig.mixer.isRunning == false)
    rig.mixer.append(Self.frame(Self.tone(8_000, seconds: 0.02), at: 1_001))
    #expect(rig.mixer.currentStatistics.unstartedBuffers == 1)
    rig.mixer.emitReadyChunks()
    rig.mixer.flush(through: WallClock(seconds: 1_010))
    #expect(rig.collected.count == 49)

    rig.advance(by: 9)
    rig.mixer.start()
    #expect(rig.mixer.currentStatistics.emittedSamples == 0)
    rig.advance(by: 0.5)
    rig.mixer.emitReadyChunks()
    // 0.48 s: 24 chunks, the first at the new start's wall clock.
    #expect(rig.collected.count == 49 + 24)
    #expect(rig.collected.walls[49] == 1_010)
    #expect(rig.collected.presentationSamples[49] == 48_480_000)
  }

  @Test("Starting a running mix is a no-op")
  func doubleStartIsANoOp() {
    let rig = Rig(wall: 1_000, uptime: 50)
    rig.mixer.start()
    rig.advance(by: 0.5)
    rig.mixer.emitReadyChunks()
    rig.mixer.start()
    rig.advance(by: 0.5)
    rig.mixer.emitReadyChunks()

    #expect(rig.collected.count == 49)
    #expect(rig.collected.walls.first == 1_000)
    #expect(rig.collected.isContiguous)
  }

  @Test("A wall-clock jump neither stretches nor squeezes the counter")
  func wallClockJump() {
    let rig = Rig(wall: 1_000, uptime: 50)
    rig.mixer.start()
    rig.advance(by: 1)
    // The wall clock steps an hour forward; uptime does not.
    rig.wall.set(rig.wall.now.seconds + 3_600)
    rig.mixer.emitReadyChunks()
    #expect(rig.collected.count == 49)

    // Sound stamped on the new wall clock "now" is due now on the counter.
    rig.mixer.append(Self.frame(Self.tone(8_000, seconds: 0.02), at: rig.wall.now.seconds))
    rig.advance(by: 0.5)
    rig.mixer.emitReadyChunks()

    #expect(rig.collected.count == 74)
    #expect(rig.collected.loudIndices == [ 50 ])
    #expect(rig.collected.walls[50] == 4_601)
    // Presentation times count samples and do not jump with the wall clock.
    #expect(rig.collected.presentationSamples[73] - rig.collected.presentationSamples[0] == 73 * 960)
  }

  @Test("Reading wall and uptime a moment apart does not shift the timeline")
  func readingJitterIsIgnored() {
    let rig = Rig(wall: 1_000, uptime: 50)
    rig.mixer.start()
    rig.advance(by: 1)
    // Half a millisecond of disagreement between the two clocks: within the tolerance.
    rig.wall.set(rig.wall.now.seconds + 0.000_5)
    rig.mixer.emitReadyChunks()
    rig.advance(by: 1)
    rig.mixer.emitReadyChunks()

    #expect(rig.collected.count == 99)
    // Still on the offset read at start: the last chunk sits exactly 98 chunks after the first.
    let walls = rig.collected.walls
    #expect(abs(walls[98] - (1_000 + 98 * 0.02)) < 0.000_001)
  }

  @Test("Host uptime counts forward in seconds")
  func hostUptimeCounts() {
    let first = HostUptime.seconds()
    usleep(20_000)
    let second = HostUptime.seconds()
    #expect(second - first >= 0.019)
    #expect(second - first < 1)
  }

  // MARK: - Both mixes from go-live

  @Test("Going live starts both mixes with no camera, and they keep counting until released")
  func goLiveHoldsBothMixes() throws {
    let router = try Self.router()
    #expect(router.audioMixer.isRunning == false)
    #expect(router.recordingMixer.isRunning == false)

    router.setProgrammeSoundLive(true)
    #expect(router.audioMixer.isRunning)
    #expect(router.recordingMixer.isRunning)

    // The grid being torn down while live does not stop the programme's sound.
    router.removeAll()
    #expect(router.audioMixer.isRunning)
    #expect(router.recordingMixer.isRunning)

    router.setProgrammeSoundLive(false)
    #expect(router.audioMixer.isRunning == false)
    #expect(router.recordingMixer.isRunning == false)
  }

  @Test("Removing the last camera stops the mixes only when the programme is not live")
  func lastCameraRemoved() throws {
    let router = try Self.router()
    let pipeline = SourcePipeline(
      sourceID: SourceID("silent-cam"),
      sourceIndex: 0,
      source: SilentSource(),
      converter: PixelConverter(),
      telemetry: PipelineTelemetry()
    )
    router.add(pipeline)
    try pipeline.start()
    router.audioMixer.start()
    router.recordingMixer.start()

    router.setProgrammeSoundLive(true)
    router.remove(sourceIndex: 0)
    #expect(router.audioMixer.isRunning)

    // Released with a camera still there, the mixes carry on for the speakers.
    let second = SourcePipeline(
      sourceID: SourceID("silent-cam-2"),
      sourceIndex: 1,
      source: SilentSource(),
      converter: PixelConverter(),
      telemetry: PipelineTelemetry()
    )
    router.add(second)
    try second.start()
    router.setProgrammeSoundLive(false)
    #expect(router.audioMixer.isRunning)
    router.remove(sourceIndex: 1)
    #expect(router.audioMixer.isRunning == false)
    #expect(router.recordingMixer.isRunning == false)
  }

  // MARK: - Helpers

  /// A mixer on a wall clock and an uptime the test moves by hand, collecting what it emits.
  private final class Rig: @unchecked Sendable {
    let wall: FixedClock
    let uptime: ManualUptime
    let collected = Collected()
    let mixer: AudioMixer

    init(wall seconds: Double, uptime start: Double, delay: Double = AudioMixer.mixDelaySeconds) {
      let wall = FixedClock(seconds)
      let uptime = ManualUptime(start)
      self.wall = wall
      self.uptime = uptime
      let collected = collected
      mixer = AudioMixer(
        clock: wall,
        delaySeconds: delay,
        uptime: { uptime.seconds },
        runsTimer: false
      ) { collected.add($0) }
    }

    /// Moves uptime and the wall clock on together.
    func advance(by seconds: Double) {
      uptime.advance(by: seconds)
      wall.set(wall.now.seconds + seconds)
    }
  }

  private final class ManualUptime: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double

    init(_ value: Double) { self.value = value }

    var seconds: Double {
      lock.lock()
      defer { lock.unlock() }
      return value
    }

    func advance(by seconds: Double) {
      lock.lock()
      value += seconds
      lock.unlock()
    }
  }

  private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [(wall: Double, pts: Int64, loud: Bool)] = []

    func add(_ frame: AudioFrame) {
      let samples = AudioPCM.stereoSamples(from: frame.sampleBuffer, sampleRate: 48_000, channelCount: 2) ?? []
      let pts = CMSampleBufferGetPresentationTimeStamp(frame.sampleBuffer).value
      lock.lock()
      chunks.append((frame.wallClock.seconds, pts, samples.contains { abs(Int($0)) > 100 }))
      lock.unlock()
    }

    private var all: [(wall: Double, pts: Int64, loud: Bool)] {
      lock.lock()
      defer { lock.unlock() }
      return chunks
    }

    var count: Int { all.count }
    /// Rounded to the sample, so float noise in the arithmetic does not fail an equality.
    var walls: [Double] { all.map { ($0.wall * 48_000).rounded() / 48_000 } }
    var presentationSamples: [Int64] { all.map(\.pts) }
    var loudIndices: [Int] { all.enumerated().filter(\.element.loud).map(\.offset) }

    /// Every chunk starts 960 samples after the one before it, by presentation time.
    var isContiguous: Bool {
      let pts = presentationSamples
      return zip(pts.dropFirst(), pts).allSatisfy { $0 - $1 == 960 }
    }
  }

  static func tone(_ value: Int16, seconds: Double) -> [Int16] {
    Array(repeating: value, count: Int(seconds * 48_000) * 2)
  }

  static func frame(_ samples: [Int16], at wall: Double) -> AudioFrame {
    let format = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description(sampleRate: 48_000, channels: 2)
    )!
    let buffer = AudioSampleBuilder.makeSampleBuffer(
      samples: samples,
      formatDescription: format,
      presentationTime: CMTime(seconds: wall, preferredTimescale: 48_000)
    )!
    return AudioFrame(sourceID: SourceID("camera"), sampleBuffer: buffer, wallClock: WallClock(seconds: wall))
  }

  private static func router() throws -> TileRouter {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-sound-clock-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let encoder = ProgramEncoder(
      telemetry: telemetry,
      converter: converter,
      config: AppConfig(programResolution: .hd720, programFrameRate: 30),
      directory: root
    )
    return TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: nil,
      programEncoder: encoder,
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
  }
}

/// A camera that never delivers anything; enough for the router to count it as a tile.
private final class SilentSource: FrameSource, @unchecked Sendable {
  let sourceID = SourceID("silent-cam")
  let displayName = "SILENT"
  private(set) var isRunning = false
  var format: SourceFormat? { nil }

  func start(sinks: FrameSinks) throws { isRunning = true }
  func stop() { isRunning = false }
}
