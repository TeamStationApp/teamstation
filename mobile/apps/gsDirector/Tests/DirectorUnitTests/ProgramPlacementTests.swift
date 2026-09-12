import AVFoundation
import CoreMedia
import Foundation
import DirectorCore
import DirectorDVR
import DirectorPipeline
import DirectorSources
import Testing

/// The programme master exported on the wall clock, across a hole where nothing was writing.
///
/// The cameras have been placed by segment start for a while; the programme was still laid end to
/// end, because two facts for a whole take is not enough to place anything. With an anchor per
/// part it gets the same treatment, which is what makes the programme and the angles agree about
/// when the app was away — and makes the programme file as long as the take rather than as long as
/// the footage.
@Suite("Programme placement", .serialized)
struct ProgramPlacementTests {
  @Test("A programme whose parts straddle an outage exports the take's full length")
  func placedProgrammeSpansTheOutage() async throws {
    let tree = try makeTree()
    defer { try? FileManager.default.removeItem(at: tree.root) }
    let index = try ArchiveIndex(url: tree.root.appendingPathComponent("index.sqlite"))
    let takeStart = WallClock(seconds: 1_758_000_000)
    let recordingID = try index.beginRecording(at: takeStart)

    // Part one runs past a fragment boundary and then the process dies. Nothing finalises it,
    // which is what makes the fragments rather than the movie header the readable part.
    let first = makeEncoder(directory: tree.program)
    try first.start(at: takeStart)
    try await write(seconds: 5, to: first)
    let partOne = try #require(first.outputURL)
    try index.insertProgramAnchor(
      recordingID: recordingID, part: 1,
      programSeconds: 0, wall: takeStart
    )

    // Twenty seconds later a new process picks the take up and writes five more seconds.
    let resumeWall = takeStart + 20
    let second = makeEncoder(directory: tree.program)
    try second.resume(startedAt: takeStart, nextPart: 2, at: resumeWall)
    try await write(seconds: 5, to: second)
    let partTwo = try #require(second.outputURL)
    try index.insertProgramAnchor(
      recordingID: recordingID, part: 2,
      programSeconds: 0, wall: resumeWall
    )
    let endedAt = takeStart + 25
    _ = await second.finish(until: endedAt)

    try index.setProgramFilename(partOne.lastPathComponent, for: recordingID)
    try index.endRecording(recordingID, at: endedAt)

    let recording = try #require(try index.recordings().first { $0.id == recordingID })
    let exporter = ExportService(
      index: index, archives: tree.archives, programDirectory: tree.program
    )
    let urls = try await exporter.exportRecording(
      recording, cameras: [], includeProgram: true, preparedRoot: tree.prepared
    )

    let exported = try #require(urls.first)
    let duration = try await AVURLAsset(url: exported).load(.duration).seconds
    // Twenty-five seconds of take: some programme, a hole where the app was gone, and the rest.
    // Laid end to end this file was about ten seconds long and every frame after the outage sat
    // fifteen seconds early.
    #expect(abs(duration - 25) < 1.5, "programme exported \(duration)s, expected about 25")

    // And the part the crash truncated is in it, not skipped: an export that quietly dropped
    // everything before the outage would report exactly the same length.
    let head = try await sampleCount(in: exported, from: 0, to: 2)
    #expect(head > 0, "nothing from before the outage survived into the export")
  }

  @Test("A take with no anchors exports the way it always did")
  func unanchoredProgrammeKeepsTheOldPath() async throws {
    let tree = try makeTree()
    defer { try? FileManager.default.removeItem(at: tree.root) }
    let index = try ArchiveIndex(url: tree.root.appendingPathComponent("index.sqlite"))
    let takeStart = WallClock(seconds: 1_758_100_000)
    let recordingID = try index.beginRecording(at: takeStart)

    let encoder = makeEncoder(directory: tree.program)
    try encoder.start(at: takeStart)
    try await write(seconds: 2, to: encoder)
    let part = try #require(encoder.outputURL)
    let endedAt = takeStart + 3
    _ = await encoder.finish(until: endedAt)
    try index.setProgramFilename(part.lastPathComponent, for: recordingID)
    try index.endRecording(recordingID, at: endedAt)

    // No anchors at all: a take from a build that did not write them.
    #expect(try index.programAnchors(recordingID: recordingID).isEmpty)

    let recording = try #require(try index.recordings().first { $0.id == recordingID })
    let exporter = ExportService(
      index: index, archives: tree.archives, programDirectory: tree.program
    )
    let urls = try await exporter.exportRecording(
      recording, cameras: [], includeProgram: true, preparedRoot: tree.prepared
    )
    let exported = try #require(urls.first)
    let duration = try await AVURLAsset(url: exported).load(.duration).seconds
    #expect(abs(duration - 3) < 1.5, "programme exported \(duration)s, expected about 3")
  }

  @Test("A part left unfinalised reports what its fragments hold, not what it was writing")
  func truncatedPartReportsWhatItHolds() async throws {
    let tree = try makeTree()
    defer { try? FileManager.default.removeItem(at: tree.root) }

    // The shape a kill leaves. Measured: the writer emits ftyp, then the movie header once the
    // first fragment interval closes, then a moof/mdat pair per interval after it. A reader gets
    // everything up to the last complete fragment and stops there, so the loss is bounded by the
    // fragment interval rather than by how long the take had been running.
    let encoder = makeEncoder(directory: tree.program)
    try encoder.start(at: WallClock(seconds: 1_758_200_000))
    try await write(seconds: 10, to: encoder)
    let abandoned = try #require(encoder.outputURL)

    let playable = try await ArchiveRemux.playableDuration(of: AVURLAsset(url: abandoned)).seconds
    #expect(playable > 2.0, "unfinalised part reported \(playable)s, expected most of ten")
    #expect(playable < ArchiveRemux.maximumSaneDuration)
  }

  @Test("A part killed inside its first fragment is skipped, and the rest still exports")
  func partKilledBeforeItsFirstFragmentIsSkipped() async throws {
    let tree = try makeTree()
    defer { try? FileManager.default.removeItem(at: tree.root) }
    let index = try ArchiveIndex(url: tree.root.appendingPathComponent("index.sqlite"))
    let takeStart = WallClock(seconds: 1_758_300_000)
    let recordingID = try index.beginRecording(at: takeStart)

    // Under one fragment interval, so the movie header was never written and there is nothing a
    // reader can make of the file. This is the one span resuming cannot save; it is bounded by
    // the fragment interval, and the export must not fail over it.
    let first = makeEncoder(directory: tree.program)
    try first.start(at: takeStart)
    try await write(seconds: 2, to: first)
    let partOne = try #require(first.outputURL)
    try index.insertProgramAnchor(
      recordingID: recordingID, part: 1,
      programSeconds: 0, wall: takeStart
    )
    var unreadable = false
    do {
      _ = try await ArchiveRemux.playableDuration(of: AVURLAsset(url: partOne))
    } catch {
      unreadable = true
    }
    #expect(unreadable, "a part killed inside its first fragment should not be readable")

    let resumeWall = takeStart + 15
    let second = makeEncoder(directory: tree.program)
    try second.resume(startedAt: takeStart, nextPart: 2, at: resumeWall)
    try await write(seconds: 5, to: second)
    let partTwo = try #require(second.outputURL)
    try index.insertProgramAnchor(
      recordingID: recordingID, part: 2,
      programSeconds: 0, wall: resumeWall
    )
    let endedAt = takeStart + 20
    _ = await second.finish(until: endedAt)
    try index.setProgramFilename(partOne.lastPathComponent, for: recordingID)
    try index.endRecording(recordingID, at: endedAt)

    let recording = try #require(try index.recordings().first { $0.id == recordingID })
    let exporter = ExportService(
      index: index, archives: tree.archives, programDirectory: tree.program
    )
    let urls = try await exporter.exportRecording(
      recording, cameras: [], includeProgram: true, preparedRoot: tree.prepared
    )
    let exported = try #require(urls.first)
    let duration = try await AVURLAsset(url: exported).load(.duration).seconds
    #expect(abs(duration - 20) < 1.5, "programme exported \(duration)s, expected about 20")
  }

  // MARK: - Helpers


  /// How many pictures the exported file actually holds in a span, so "the right length" can be
  /// told apart from "the right length, padded".
  private func sampleCount(in url: URL, from: Double, to: Double) async throws -> Int {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return 0 }
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(
      start: CMTime(seconds: from, preferredTimescale: 600),
      duration: CMTime(seconds: to - from, preferredTimescale: 600)
    )
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    guard reader.canAdd(output) else { return 0 }
    reader.add(output)
    guard reader.startReading() else { return 0 }
    defer { reader.cancelReading() }
    var count = 0
    while output.copyNextSampleBuffer() != nil { count += 1 }
    return count
  }

  private struct Tree {
    var root: URL
    var archives: URL
    var program: URL
    var prepared: URL
  }

  private func makeTree() throws -> Tree {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-placement-\(UUID().uuidString)", isDirectory: true)
    let tree = Tree(
      root: root,
      archives: root.appendingPathComponent("Archives"),
      program: root.appendingPathComponent("Program"),
      prepared: root.appendingPathComponent("Prepared")
    )
    for url in [root, tree.archives, tree.program, tree.prepared] {
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    return tree
  }

  private func makeEncoder(directory: URL) -> ProgramEncoder {
    ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: directory
    )
  }

  // These tests write one anchor per part into the index by hand, from the take's own timeline,
  // rather than taking whatever the encoder's clock reports. The placement is what is under test
  // here; where the anchors come from is `ProgramResumeTests`'s business.

  /// Feeds the encoder video and audio at real time, as the live compositor and mix bus do.
  ///
  /// Both matter. The programme timeline advances by the wall clock that passes rather than by the
  /// timestamps it is handed, and a movie fragment cannot close until every track has reached the
  /// boundary — an encoder given pictures and no sound writes one unbounded `mdat` and no movie
  /// header at all, which is the difference between a crash costing one fragment and costing the
  /// whole part.
  private func write(seconds: Int, to encoder: ProgramEncoder, from firstFrame: Int = 0) async throws {
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())
    let format = try #require(
      AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(
          sampleRate: AudioMixer.sampleRate,
          channels: UInt32(AudioMixer.channelCount)
        )
      )
    )
    let samplesPerFrame = Int(AudioMixer.sampleRate / 30) * AudioMixer.channelCount
    let silence = [Int16](repeating: 0, count: samplesPerFrame)
    for index in 0 ..< (seconds * 30) {
      let time = CMTime(value: CMTimeValue(firstFrame + index), timescale: 30)
      encoder.append(buffer, presentationTime: time)
      if let audio = AudioSampleBuilder.makeSampleBuffer(
        samples: silence, formatDescription: format, presentationTime: time
      ) {
        encoder.append(
          audio: AudioFrame(
            sourceID: SourceID("mix"), sampleBuffer: audio, wallClock: WallClock(seconds: 0)
          )
        )
      }
      try await Task.sleep(nanoseconds: 33_000_000)
    }
    // A fragment reaches the disk on the writer's own schedule. Reading the file the instant the
    // last frame went in measures the test's timing, not the writer's behaviour.
    try await Task.sleep(nanoseconds: 500_000_000)
  }
}
