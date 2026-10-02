import AVFoundation
import CoreMedia
import DirectorCore
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// The recording's own mix: it waits for camera sound that arrives late, and the programme master
/// lays what it mixes beside the picture of the same moment.
@Suite("Recording sound")
struct RecordingSoundTests {
  // MARK: - Placement

  /// Feeds one picture and waits for the writer to take it.
  ///
  /// Production delivers on the programme clock, one frame per frame period. A test loop hands over
  /// 360 frames in microseconds, and on a loaded machine the writer refuses most of them — the full
  /// suite produced 0.4 s of picture against 12 s of sound. Pacing on `frameCount` is deterministic
  /// where a sleep is a guess.
  private func deliver(
    _ encoder: ProgramEncoder,
    _ picture: CVPixelBuffer,
    index: Int,
    origin: Double
  ) {
    let before = encoder.frameCount
    encoder.append(
      picture,
      presentationTime: CMTime(value: CMTimeValue(index), timescale: 30),
      captureWall: WallClock(seconds: origin + Double(index) / 30),
      onClockGrid: true
    )
    // Bounded: a frame the writer will never take must not hang the suite.
    for _ in 0 ..< 200 where encoder.frameCount == before { usleep(500) }
  }


  /// The origin is seeded from the opening and then held. `offer` is fed implied origins the way
  /// `ProgramEncoder` feeds them: content wall of the picture, less where it was placed.
  private func settled(
    origin partStart: Double,
    jitter: [Double] = [0],
    rate: Double = 60
  ) -> ProgrammeSoundOrigin {
    var origin = ProgrammeSoundOrigin()
    var programme = 0.0
    var index = 0
    while !origin.isSettled {
      origin.offer(
        impliedPartStart: partStart + jitter[index % jitter.count],
        atProgramme: programme
      )
      programme += 1 / rate
      index += 1
      if index > 10_000 { break }
    }
    return origin
  }

  @Test("A steady mix is laid down contiguously, beside the pictures")
  func contiguous() {
    let origin = settled(origin: 990)
    let times = (0 ..< 5).compactMap { origin.timeline(forCaptureWall: 1_000 + Double($0) * 0.02) }
    #expect(times.map { ($0 * 1_000).rounded() } == [ 10_000, 10_020, 10_040, 10_060, 10_080 ])
  }

  /// The defect this whole change is about. Arrival jitter within one camera spans 0.18-0.25 s, and
  /// the predecessor followed it with a 0.1 s deadband — so it reseated constantly, and each reseat
  /// left a gap the muxer closed or dropped buffers outright. Take 900 lost 50.00 s that way while
  /// the quantity being followed finished 0.114 s from where it started.
  @Test("Jitter in where the pictures sit never moves the sound, however much of it there is")
  func jitterNeverMovesTheSound() {
    let quiet = settled(origin: 990)
    let violent = settled(origin: 990, jitter: [-0.25, 0.18, -0.12, 0.24, 0, -0.2, 0.15])
    // The medians differ by at most the jitter, and neither drifts: what matters is that each is a
    // constant, so sound advances with wall clock and nothing is ever repositioned.
    for step in 0 ..< 50 {
      let wall = 1_000 + Double(step) * 0.02
      guard let a = quiet.timeline(forCaptureWall: wall),
            let b = violent.timeline(forCaptureWall: wall)
      else {
        Issue.record("step \(step) was dropped")
        return
      }
      #expect(abs((a - b) - (quiet.partStartWall.map { (violent.partStartWall ?? 0) - $0 } ?? 0)) < 1e-9)
    }
  }

  @Test("The origin is a median of the opening, not the first frame's guess")
  func originIsAMedian() {
    // One wild opening frame among steady ones must not become the part's origin.
    let origin = settled(origin: 990, jitter: [0, 0, 0, 0, 5, 0, 0, 0, 0])
    #expect(origin.partStartWall == 990)
  }

  @Test("Once settled the origin never moves again, whatever later frames imply")
  func settledOriginIsFinal() {
    var origin = settled(origin: 990)
    let before = origin.partStartWall
    for step in 0 ..< 500 {
      origin.offer(impliedPartStart: 990 + Double(step), atProgramme: 100 + Double(step))
    }
    #expect(origin.partStartWall == before)
  }

  @Test("Sound captured before the part's first picture is left out")
  func beforeThePart() {
    let origin = settled(origin: 1_000.5)
    #expect(origin.timeline(forCaptureWall: 1_000) == nil)
  }

  @Test("Nothing is placed until the opening has been sampled")
  func nothingBeforeTheSeed() {
    var origin = ProgrammeSoundOrigin()
    #expect(origin.timeline(forCaptureWall: 1_000) == nil)
    origin.offer(impliedPartStart: 990, atProgramme: 0)
    #expect(origin.isSettled == false)
    #expect(origin.timeline(forCaptureWall: 1_000) == nil)
  }

  @Test("A part reset starts the next part's origin from its own opening")
  func resetReseeds() {
    var origin = settled(origin: 990)
    origin.reset()
    #expect(origin.isSettled == false)
    #expect(origin.partStartWall == nil)
  }

  // MARK: - The two mixes

  @Test("Sound later than the live mix waits is silence there, and in its place in the recording's mix")
  func lateSound() {
    let clock = FixedClock(10.0)
    let live = Collected()
    let recording = Collected()
    let liveMixer = AudioMixer(clock: clock) { live.add($0) }
    let recordingMixer = AudioMixer(clock: clock, delaySeconds: 5, windowSeconds: 10) { recording.add($0) }
    for mixer in [ liveMixer, recordingMixer ] {
      mixer.append(Self.frame(Self.tone(0, seconds: 0.1), at: 10.0))
    }
    // 0.62 s on, the live mix has played up to 10.6 and the recording's nothing yet.
    clock.set(10.62)
    liveMixer.emitReadyChunks()
    recordingMixer.emitReadyChunks()
    // Sound captured at 10.3 arrives only now.
    let late = Self.frame(Self.tone(8_000, seconds: 0.04), at: 10.3)
    liveMixer.append(late)
    recordingMixer.append(late)
    clock.set(15.62)
    liveMixer.emitReadyChunks()
    recordingMixer.emitReadyChunks()

    #expect(liveMixer.currentStatistics.lateBuffers == 1)
    #expect(live.loudWalls.isEmpty)
    #expect(recordingMixer.currentStatistics.lateBuffers == 0)
    #expect(recording.loudWalls == [ 10.3, 10.32 ])
  }

  @Test("At Stop the recording's mix hands over everything it holds at once")
  func flushAtStop() {
    let clock = FixedClock(20.0)
    let recording = Collected()
    let mixer = AudioMixer(clock: clock, delaySeconds: 5, windowSeconds: 10) { recording.add($0) }
    mixer.append(Self.frame(Self.tone(8_000, seconds: 1), at: 19.0))
    mixer.emitReadyChunks()
    #expect(recording.count == 0)
    mixer.flush(through: WallClock(seconds: 20.0))
    #expect(recording.count == 50)
    #expect(recording.loudWalls.count == 50)
  }

  @Test("At Stop the master's sound reaches the end of its picture")
  func soundReachesTheEndOfThePicture() async throws {
    // The mix hands over what it holds at Stop, but sound captured in its last seconds has not
    // arrived yet, so the tail of the track is silence the encoder has to lay down itself. Queueing
    // it is not enough: it has to be written before the inputs are marked finished. Every master in
    // the 2026-09-16 soak came out with its picture at the take's length and its sound seven to ten
    // seconds short, because the tail was queued and then thrown away.
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-sound-tail-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
    // A real instant, and frames fed on the clock grid. With a fixture epoch
    // `contentLagSeconds` never sets — it only takes a capture wall within 10 s of `Date()` — so
    // the origin anchors to real now and every chunk lands before the part; and without
    // `onClockGrid` the grid-slack rule replaces each frame's slot with real time's, which in a
    // loop faster than real time drops all but the first. Either way the encoder writes no real
    // sound and the assertions below pass on the Stop silence fill alone.
    let origin = Date().timeIntervalSince1970
    try encoder.start(at: WallClock(seconds: origin))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let picture = try #require(factory.makeBuffer())

    // Twelve seconds of picture, and sound for only the first second of it: the gap stands in for
    // the mix's wait, and makes the tail hundreds of buffers rather than a handful.
    let seconds = 12
    for index in 0 ..< (seconds * 30) {
      deliver(encoder, picture, index: index, origin: origin)
    }
    for index in 0 ..< 50 {
      encoder.append(audio: Self.frame(Self.tone(8_000, seconds: 0.02), at: origin + Double(index) * 0.02))
    }

    // Guard the fixture, not just the result. Both of the ways this test can quietly stop
    // exercising the writer — a fixture epoch, or frames off the clock grid — leave the assertions
    // below passing on the Stop silence fill alone.
    #expect(
      encoder.acceptedSoundCountForTesting > 20,
      "the writer took \(encoder.acceptedSoundCountForTesting) real chunks; this test is measuring the fill"
    )
    let url = try #require(await encoder.finish(until: WallClock(seconds: origin + Double(seconds))))
    let asset = AVURLAsset(url: url)
    let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let sound = try #require(try await asset.loadTracks(withMediaType: .audio).first)
    let picturesLast = try await video.load(.timeRange).duration.seconds
    let soundLasts = try await sound.load(.timeRange).duration.seconds
    #expect(picturesLast > 11)
    #expect(
      abs(soundLasts - picturesLast) < 0.25,
      "sound lasts \(soundLasts) s against \(picturesLast) s of picture"
    )
  }

  /// A writer that dies leaves a continuation part, and each part is its own file with its own
  /// timeline — so each seeds its own origin at its own opening. The invariant is per part, which
  /// is what the anchors and `ProgrammeExport` already assume.
  @Test("A continuation part's sound is as long as its picture, on its own origin")
  func continuationPartHoldsTheInvariant() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-sound-parts-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
    // A real instant, and frames fed on the clock grid. With a fixture epoch
    // `contentLagSeconds` never sets — it only takes a capture wall within 10 s of `Date()` — so
    // the origin anchors to real now and every chunk lands before the part; and without
    // `onClockGrid` the grid-slack rule replaces each frame's slot with real time's, which in a
    // loop faster than real time drops all but the first. Either way the encoder writes no real
    // sound and the assertions below pass on the Stop silence fill alone.
    let origin = Date().timeIntervalSince1970
    try encoder.start(at: WallClock(seconds: origin))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let picture = try #require(factory.makeBuffer())

    // Four seconds of picture and sound, a writer death, then four more of each.
    func feed(from startFrame: Int, frames: Int) {
      for index in startFrame ..< (startFrame + frames) {
        deliver(encoder, picture, index: index, origin: origin)
      }
      for index in (startFrame * 5 / 3) ..< ((startFrame + frames) * 5 / 3) {
        encoder.append(
          audio: Self.frame(Self.tone(8_000, seconds: 0.02), at: origin + Double(index) * 0.02)
        )
      }
    }
    feed(from: 0, frames: 120)
    encoder.recoverAfterFailure()
    feed(from: 120, frames: 120)

    // Guard the fixture, not just the result. Both of the ways this test can quietly stop
    // exercising the writer — a fixture epoch, or frames off the clock grid — leave the assertions
    // below passing on the Stop silence fill alone.
    #expect(
      encoder.acceptedSoundCountForTesting > 20,
      "the writer took \(encoder.acceptedSoundCountForTesting) real chunks; this test is measuring the fill"
    )
    _ = await encoder.finish(until: WallClock(seconds: origin + 8))
    let parts = encoder.outputURLs
    #expect(parts.count == 2, "expected a continuation part, got \(parts.count)")

    // Only the continuation is checked. `recoverWriter` marks the dead writer's inputs finished and
    // drops it without `finishWriting()` — a writer that failed often cannot be finalised, which is
    // why it failed — so part 1 has no movie header and will not open. That is pre-existing and
    // handled: `ProgrammeExport.plan` returns `.parts` for more than one part and `.unreadable` for
    // a file that does not read, and sends the take through a re-encode. Do not "fix" this test by
    // expecting part 1 to be readable.
    let continuation = try #require(parts.last)
    let asset = AVURLAsset(url: continuation)
    let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let sound = try #require(try await asset.loadTracks(withMediaType: .audio).first)
    let pictured = try await video.load(.timeRange).duration.seconds
    let heard = try await sound.load(.timeRange).duration.seconds
    #expect(pictured > 0.5, "continuation holds \(pictured) s of picture")
    #expect(
      heard >= pictured - 0.25,
      "continuation: sound lasts \(heard) s against \(pictured) s of picture"
    )
  }

  @Test("The live mix still runs a single chunk behind")
  func liveDelay() {
    #expect(AudioMixer.mixDelaySeconds == 0.02)
    #expect(TileRouter.recordingMixDelaySeconds == 5)
  }

  // MARK: - Helpers

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

  /// Every chunk a mixer emitted: where it sits and whether it holds anything louder than silence.
  private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [(wall: Double, loud: Bool)] = []

    func add(_ frame: AudioFrame) {
      let samples = AudioPCM.stereoSamples(from: frame.sampleBuffer, sampleRate: 48_000, channelCount: 2) ?? []
      let loud = samples.contains { abs(Double($0)) > 100 }
      lock.lock()
      chunks.append((frame.wallClock.seconds, loud))
      lock.unlock()
    }

    var count: Int {
      lock.lock()
      defer { lock.unlock() }
      return chunks.count
    }

    var loudWalls: [Double] {
      lock.lock()
      defer { lock.unlock() }
      return chunks.filter(\.loud).map { ($0.wall * 100).rounded() / 100 }
    }
  }
}
