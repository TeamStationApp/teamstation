import AVFoundation
import CoreMedia
import Foundation
import DirectorCore
import DirectorDVR
import DirectorPipeline
import DirectorSources
import Testing

/// Picking up a programme master written by a process that is no longer running.
///
/// The encoder could already open a continuation part after its writer died, but only because
/// the object that had been writing was still there to say what it had written. After a crash
/// nothing is: the file family is on disk, the take's start and its anchors are in the index, and
/// everything else went with the process. These say the new part lands in the same family, holds
/// the right length, and anchors itself where it actually began.
@Suite("Programme resume", .serialized)
struct ProgramResumeTests {
  @Test("A resumed part joins the same file family and lasts its own span, not the take's")
  func resumedPartJoinsTheFamily() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let anchors = AnchorLog()
    // A take that began twenty seconds ago.
    let takeStart = WallClock(date: Date()) - 20

    // The process that started the take wrote three seconds and was never given the chance to
    // finish — which is what a kill looks like from the file's point of view.
    let first = makeEncoder(directory: root, anchors: anchors, recording: 1)
    try first.start(at: takeStart)
    try await write(seconds: 3, to: first)
    let abandoned = try #require(first.outputURL)

    // A new process. It knows only when the take began and that part 1 is taken.
    let second = makeEncoder(directory: root, anchors: anchors, recording: 1)
    try second.resume(startedAt: takeStart, nextPart: 2, at: WallClock(date: Date()))
    let resumedAt = Date().timeIntervalSince1970
    try await write(seconds: 3, to: second)
    let resumed = try #require(second.outputURL)
    _ = await second.finish(until: WallClock(date: Date()))

    // Same stem, so `programSourceFiles` collects both as one take.
    let stem = abandoned.deletingPathExtension().lastPathComponent
    #expect(resumed.lastPathComponent == "\(stem)-2.mp4")
    #expect(RecordingExport.programSourceFiles(named: abandoned.lastPathComponent, in: root)
      .map(\.lastPathComponent) == [abandoned.lastPathComponent, resumed.lastPathComponent])

    // Each part anchors under its own number, and the resumed one where its first picture went in.
    let starts = anchors.partStarts()
    #expect(Set(starts.keys) == [1, 2])
    #expect(abs((starts[2] ?? 0) - resumedAt) < 0.5, "part 2 anchored \((starts[2] ?? 0) - resumedAt) s from its first picture")

    // The resumed part covers the three seconds it was running, not the twenty-odd the take has
    // lasted: that span belongs to part 1 and to the hole between them.
    let duration = try await AVURLAsset(url: resumed).load(.duration).seconds
    #expect(duration > 2.0 && duration < 5.0, "resumed part was \(duration)s, expected about 3.5")
  }

  @Test("A resumed part starts at its first picture, however long the cameras take to come back")
  func resumedPartWaitsForItsFirstPicture() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let anchors = AnchorLog()
    let takeStart = WallClock(date: Date()) - 60

    // Resumed, and then nothing for three seconds: the app is back but no camera is delivering.
    let encoder = makeEncoder(directory: root, anchors: anchors, recording: 1)
    try encoder.resume(startedAt: takeStart, nextPart: 2, at: WallClock(date: Date()))
    try await Task.sleep(nanoseconds: 3_000_000_000)
    let firstPicture = Date().timeIntervalSince1970
    try await write(seconds: 3, to: encoder)
    let url = try #require(encoder.outputURL)
    _ = await encoder.finish(until: WallClock(date: Date()))

    // The wait is not in the file: it holds the three seconds of pictures, not six. Measured from
    // the resume instead, the stop would have filled the part out by the whole wait.
    let duration = try await AVURLAsset(url: url).load(.duration).seconds
    #expect(duration > 2.0 && duration < 5.0, "part was \(duration)s, expected about 3.5")
    let start = try #require(anchors.partStarts()[2])
    #expect(abs(start - firstPicture) < 0.5, "part anchored \(start - firstPicture) s from its first picture")
    // Every anchor agrees about where the part starts. A stop that filled at speed would have left
    // anchors claiming an earlier start, and the export places a part by its earliest ones.
    #expect(anchors.spread(part: 2) < 0.5, "anchors disagree by \(anchors.spread(part: 2)) s")
  }

  @Test("A resumed part never overwrites a file the index has nothing on")
  func resumeStepsOverAnOrphanedPart() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let takeStart = WallClock(date: Date())

    let first = makeEncoder(directory: root)
    try first.start(at: takeStart)
    try await write(seconds: 1, to: first)
    _ = await first.finish()

    // A part 2 exists on disk that nothing recorded — the shape a crash between opening a file
    // and its first anchor leaves behind. It holds footage; resuming must step over it.
    let second = makeEncoder(directory: root)
    try second.resume(startedAt: takeStart, nextPart: 2, at: takeStart + 10)
    try await write(seconds: 1, to: second)
    let orphan = try #require(second.outputURL)
    let orphanBytes = try #require(
      try FileManager.default.attributesOfItem(atPath: orphan.path)[.size] as? Int
    )

    let third = makeEncoder(directory: root)
    try third.resume(startedAt: takeStart, nextPart: 2, at: takeStart + 20)
    try await write(seconds: 1, to: third)
    let resumed = try #require(third.outputURL)
    _ = await third.finish(until: takeStart + 22)

    #expect(resumed.lastPathComponent.hasSuffix("-3.mp4"))
    #expect(orphan.lastPathComponent.hasSuffix("-2.mp4"))
    // Untouched: same file, same bytes.
    #expect(FileManager.default.fileExists(atPath: orphan.path))
    let after = try #require(
      try FileManager.default.attributesOfItem(atPath: orphan.path)[.size] as? Int
    )
    #expect(after == orphanBytes)
  }

  @Test("Resuming an encoder that is already writing is refused")
  func resumeRefusesARunningEncoder() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let encoder = makeEncoder(directory: root)
    let takeStart = WallClock(date: Date())
    try encoder.start(at: takeStart)

    #expect(throws: ProgramEncoder.ProgramEncoderError.self) {
      try encoder.resume(startedAt: takeStart, nextPart: 2, at: takeStart + 30)
    }
    _ = await encoder.finish()
  }

  @Test("Resuming anchors into the index under the part the index said was next")
  func resumedAnchorsLandInTheIndex() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let takeStart = WallClock(date: Date())
    let recording = try index.beginRecording(at: takeStart)

    let first = makeEncoder(directory: root, index: index, recording: recording)
    try first.start(at: takeStart)
    try await write(seconds: 3, to: first)
    #expect(try index.nextProgramPart(forRecording: recording) == 2)

    // The relaunch reads the next part from the index and hands it straight to the encoder.
    let next = try index.nextProgramPart(forRecording: recording)
    let second = makeEncoder(directory: root, index: index, recording: recording)
    try second.resume(startedAt: takeStart, nextPart: next, at: WallClock(date: Date()))
    try await write(seconds: 3, to: second)
    _ = await second.finish()

    let parts = Set(try index.programAnchors(recordingID: recording).map(\.part))
    #expect(parts == [1, 2])
    let starts = try index.programPartStarts(recordingID: recording)
    #expect((starts[2]?.seconds ?? 0) > (starts[1]?.seconds ?? .infinity) + 2.5)
    #expect(try index.nextProgramPart(forRecording: recording) == 3)
  }

  // MARK: - Helpers

  /// What the anchor sink was handed, from whatever thread it ran on.
  private final class AnchorLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(part: Int, seconds: Double, wall: Double)] = []

    func record(_ part: Int, _ seconds: Double, _ wall: WallClock) {
      lock.lock()
      entries.append((part, seconds, wall.seconds))
      lock.unlock()
    }

    /// How far apart a part's anchors put its start.
    func spread(part: Int) -> Double {
      lock.lock()
      defer { lock.unlock() }
      let starts = entries.filter { $0.part == part }.map { $0.wall - $0.seconds }
      guard let low = starts.min(), let high = starts.max() else { return 0 }
      return high - low
    }

    /// Where each part's timeline begins, from its earliest anchor.
    func partStarts() -> [Int: Double] {
      lock.lock()
      defer { lock.unlock() }
      var starts: [Int: Double] = [:]
      for entry in entries {
        let start = entry.wall - entry.seconds
        starts[entry.part] = min(starts[entry.part] ?? .infinity, start)
      }
      return starts
    }
  }

  private func makeRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-resume-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func makeEncoder(
    directory: URL,
    anchors: AnchorLog? = nil,
    index: ArchiveIndex? = nil,
    recording: Int64? = nil
  ) -> ProgramEncoder {
    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: directory
    )
    if let anchors {
      encoder.setAnchorSink { _, part, seconds, wall in anchors.record(part, seconds, wall) }
    } else if let index {
      encoder.setAnchorSink { recording, part, seconds, wall in
        try? index.insertProgramAnchor(
          recordingID: recording, part: part, programSeconds: seconds, wall: wall
        )
      }
    }
    encoder.setAnchorRecording(recording)
    return encoder
  }

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
        // The recording's mix is stamped with when its sound was captured, which for sound made
        // beside the picture is now.
        encoder.append(
          audio: AudioFrame(
            sourceID: SourceID("mix"), sampleBuffer: audio, wallClock: WallClock(date: Date())
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
