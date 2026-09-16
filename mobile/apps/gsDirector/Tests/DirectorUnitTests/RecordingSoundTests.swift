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

  @Test("A steady mix is laid down contiguously, beside the pictures")
  func contiguous() {
    var placement = RecordingSoundPlacement()
    var written: Double?
    var times: [Double] = []
    for index in 0 ..< 5 {
      let wall = 1_000 + Double(index) * 0.02
      guard let time = placement.place(wall: wall, duration: 0.02, contentOffset: -990, writtenUntil: written) else {
        Issue.record("buffer \(index) was dropped")
        return
      }
      times.append(time)
      written = time + 0.02
    }
    #expect(times.map { ($0 * 1_000).rounded() } == [ 10_000, 10_020, 10_040, 10_060, 10_080 ])
  }

  @Test("Jitter in where the pictures sit does not move the sound")
  func jitterHolds() {
    var placement = RecordingSoundPlacement()
    let first = placement.place(wall: 1_000, duration: 0.02, contentOffset: -990, writtenUntil: nil)
    // The pictures now say 60 ms later: inside the allowance, so the sound carries on where it was.
    let second = placement.place(wall: 1_000.02, duration: 0.02, contentOffset: -989.94, writtenUntil: 10.02)
    #expect(first == 10)
    #expect(second.map { ($0 * 1_000).rounded() } == 10_020)
  }

  @Test("A display delay that settles later moves the sound with it, leaving a gap")
  func laterReseats() {
    var placement = RecordingSoundPlacement()
    _ = placement.place(wall: 1_000, duration: 0.02, contentOffset: -990, writtenUntil: nil)
    let moved = placement.place(wall: 1_000.02, duration: 0.02, contentOffset: -989.7, writtenUntil: 10.02)
    #expect(moved.map { ($0 * 1_000).rounded() } == 10_320)
  }

  @Test("Moving earlier drops what the track already holds, then carries on past its end")
  func earlierDrops() {
    var placement = RecordingSoundPlacement()
    var written: Double?
    for index in 0 ..< 10 {
      if let time = placement.place(
        wall: 1_000 + Double(index) * 0.02,
        duration: 0.02,
        contentOffset: -990,
        writtenUntil: written
      ) {
        written = time + 0.02
      }
    }
    // Written to 10.20. The pictures now say 150 ms earlier, so sound captured at 1000.20 belongs at
    // 10.05, which the track already holds.
    #expect(placement.place(wall: 1_000.20, duration: 0.02, contentOffset: -990.15, writtenUntil: written) == nil)
    // Once the new placement passes the end of the track, the sound carries on from there.
    let resumed = placement.place(wall: 1_000.36, duration: 0.02, contentOffset: -990.15, writtenUntil: written)
    #expect(resumed.map { ($0 * 1_000).rounded() } == 10_210)
  }

  @Test("Sound captured before the part's first picture is left out")
  func beforeThePart() {
    var placement = RecordingSoundPlacement()
    #expect(placement.place(wall: 1_000, duration: 0.02, contentOffset: -1_000.5, writtenUntil: nil) == nil)
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
    let origin = 1_000.0
    try encoder.start(at: WallClock(seconds: origin))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let picture = try #require(factory.makeBuffer())

    // Twelve seconds of picture, and sound for only the first second of it: the gap stands in for
    // the mix's wait, and makes the tail hundreds of buffers rather than a handful.
    let seconds = 12
    for index in 0 ..< (seconds * 30) {
      encoder.append(
        picture,
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 30),
        captureWall: WallClock(seconds: origin + Double(index) / 30)
      )
    }
    for index in 0 ..< 50 {
      encoder.append(audio: Self.frame(Self.tone(8_000, seconds: 0.02), at: origin + Double(index) * 0.02))
    }

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

  @Test("The live mix still runs a single chunk behind")
  func liveDelay() {
    #expect(AudioMixer.mixDelaySeconds == 0.02)
    #expect(TileRouter.recordingMixDelaySeconds == 5)
  }

  // MARK: - Helpers

  private static func tone(_ value: Int16, seconds: Double) -> [Int16] {
    Array(repeating: value, count: Int(seconds * 48_000) * 2)
  }

  private static func frame(_ samples: [Int16], at wall: Double) -> AudioFrame {
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
