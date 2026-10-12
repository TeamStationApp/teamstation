import AVFoundation
import CoreMedia
import CoreVideo
import DirectorCore
import DirectorDVR
import DirectorExport
@testable import DirectorMedia
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// Copying the programme master out to the take's window must not leave its sound behind.
///
/// The master a real Stop produces has its sound running a little past its picture: the recording's
/// mix hands over sound captured up to the stop while the last pictures are already written. So the
/// master here is made by `ProgramEncoder` rather than by hand, and what the export does to it is
/// what the export does on the device.
@Suite("Programme copy keeps its sound")
struct ProgrammeCopySoundTests {
  @Test("A master whose sound outlasts its picture copies with its sound intact")
  func soundSurvivesTheCut() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-copy-\(UUID().uuidString)", isDirectory: true)
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
    let origin = 3_000.0
    let seconds = 10
    try encoder.start(at: WallClock(seconds: origin))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let picture = try #require(factory.makeBuffer())
    for index in 0 ..< (seconds * 30) {
      encoder.append(
        picture,
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 30),
        captureWall: WallClock(seconds: origin + Double(index) / 30)
      )
    }
    // Sound with holes in it, the way a starved camera's reaches the mix: three runs of a second
    // each, seconds apart, and nothing after 7 s. Contiguous sound is not what shaping produces.
    for run in 0 ..< 3 {
      for index in 0 ..< 50 {
        encoder.append(audio: Self.tone(at: origin + Double(run) * 3 + Double(index) * 0.02))
      }
    }
    let master = try #require(await encoder.finish(until: WallClock(seconds: origin + Double(seconds))))

    let before = try await Self.trackSeconds(of: master)
    #expect(before.sound > before.picture - 0.25, "the master itself is short: \(before)")

    let copied = root.appendingPathComponent("copy.mov")
    try await ArchiveRemux.copyProgramme(
      part: master,
      offset: 0,
      length: Double(seconds),
      destination: copied
    )

    let after = try await Self.trackSeconds(of: copied)
    #expect(after.picture > Double(seconds) - 0.5)
    #expect(
      after.sound > after.picture - 0.25,
      "copied sound lasts \(after.sound) s against \(after.picture) s of picture (master had \(before.sound) s against \(before.picture) s)"
    )
  }

  private static func trackSeconds(of url: URL) async throws -> (picture: Double, sound: Double) {
    let asset = AVURLAsset(url: url)
    let video = try await asset.loadTracks(withMediaType: .video).first
    let audio = try await asset.loadTracks(withMediaType: .audio).first
    return (
      try await video?.load(.timeRange).duration.seconds ?? 0,
      try await audio?.load(.timeRange).duration.seconds ?? 0
    )
  }

  private static func tone(at wall: Double) -> AudioFrame {
    let format = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description(sampleRate: 48_000, channels: 2)
    )!
    let buffer = AudioSampleBuilder.makeSampleBuffer(
      samples: Array(repeating: Int16(8_000), count: Int(0.02 * 48_000) * 2),
      formatDescription: format,
      presentationTime: CMTime(seconds: wall, preferredTimescale: 48_000)
    )!
    return AudioFrame(sourceID: SourceID("camera"), sampleBuffer: buffer, wallClock: WallClock(seconds: wall))
  }
}
