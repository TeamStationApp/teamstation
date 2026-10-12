import AVFoundation
import CoreMedia
import CoreVideo
import DirectorCore
import DirectorExport
@testable import DirectorMedia
import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// The programme recording's lifecycle, against a throwaway index: open, start, stop, resume.
@Suite("Recording session", .serialized)
@MainActor
struct RecordingSessionTests {
  private static let settings = RecordingSettings(
    programme: EncodeSettings(
      codec: .h264,
      resolution: ProgramResolution(width: 160, height: 120),
      frameRate: 30,
      bitrate: 1_000_000,
      keyframeSeconds: 2
    ),
    takeEncoding: AppConfig.default.takeEncoding,
    resumeDowntimeLimitSeconds: 3_600
  )

  @Test("A take opens its row, records a master, and closes with the master listed")
  func startAndStop() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    var rates: [Int] = []
    let session = RecordingSession(
      index: index,
      encoder: makeEncoder(root),
      clock: SystemClock(),
      setRecordingRate: { rates.append($0) }
    )
    #expect(!session.isRecording)
    let start = SystemClock().now
    let id = try session.open(at: start, settings: Self.settings)
    #expect(session.recordingID == id)
    #expect(session.startedAt == start)
    #expect(try index.encoding(for: id) == Self.settings.takeEncoding)
    try session.startProgramme(at: start, settings: Self.settings)
    #expect(rates == [ 30 ])
    let first = try #require(try index.recordings().first { $0.id == id }?.programFilename)
    #expect(!first.isEmpty)

    try await feed(session.encoder, seconds: 2)
    session.detachAnchors()
    let url = await session.finishProgramme(until: SystemClock().now)
    #expect(url != nil)
    let ended = SystemClock().now
    session.close(endedAt: ended)
    #expect(!session.isRecording)
    #expect(session.startedAt == nil)
    let row = try #require(try index.recordings().first { $0.id == id })
    #expect(row.programFilename == first)
    #expect(row.endedAt != nil)
    // The sound check of the part landed on the take's row.
    #expect(try !index.soundChecks(for: id).isEmpty)
    #expect(try !index.programAnchors(recordingID: id).isEmpty)
  }

  @Test("A take interrupted mid-way resumes as part 2, listed after part 1")
  func resumesAsTheNextPart() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let before = RecordingSession(index: index, encoder: makeEncoder(root), clock: SystemClock())
    let start = SystemClock().now
    let id = try before.open(at: start, settings: Self.settings)
    try before.startProgramme(at: start, settings: Self.settings)
    before.beginLiveSession(recording: id, isLive: { true })
    #expect(before.isBeating)
    try await feed(before.encoder, seconds: 2)
    before.beatLiveSession(isLive: true)
    // Killed: nothing is finished, and the heartbeat stops with the process.
    before.stopHeartbeat()

    let plan = try #require(try LiveSessionResume.plan(index: index, now: SystemClock().now, limit: 3_600))
    guard case let .resume(recording, streaming) = plan.outcome, let take = recording else {
      Issue.record("expected the take to resume, got \(plan.outcome)")
      return
    }
    #expect(streaming == false)
    #expect(take.nextProgramPart == 2)

    let after = RecordingSession(index: index, encoder: makeEncoder(root), clock: SystemClock())
    let resumes = try after.resume(take, at: SystemClock().now, settings: Self.settings)
    #expect(resumes == 1)
    #expect(after.recordingID == id)
    #expect(after.startedAt == start)
    let listed = try #require(try index.recordings().first { $0.id == id }?.programFilename)
    #expect(listed.split(separator: ",").count == 2)
    try await feed(after.encoder, seconds: 1)
    after.detachAnchors()
    _ = await after.finishProgramme(until: SystemClock().now)
    after.close(endedAt: SystemClock().now)
    let row = try #require(try index.recordings().first { $0.id == id })
    #expect(row.programFilename == listed)
    #expect(try index.programPartStarts(recordingID: id).keys.sorted() == [ 1, 2 ])
  }

  @Test("The live session's two halves close independently, and the heartbeat stops with the last")
  func liveSessionHalves() throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let session = RecordingSession(index: index, encoder: makeEncoder(root), clock: SystemClock())
    let id = try session.open(at: SystemClock().now, settings: Self.settings)
    session.beginLiveSession(recording: id, isLive: { true })
    session.beginLiveSession(streaming: true, isLive: { true })
    #expect(try index.liveSession()?.streaming == true)
    // A stream ended on the server: only the streaming half goes.
    session.endLiveSession(streaming: true, stillLive: true)
    #expect(session.isBeating)
    #expect(try index.liveSession()?.streaming == false)
    #expect(try index.liveSession()?.recordingID == id)
    // Nothing live on the next beat closes the rest.
    session.beatLiveSession(isLive: false)
    #expect(!session.isBeating)
    #expect(try index.liveSession()?.isEmpty ?? true)
  }

  @Test("A stream ended before a relaunch is not resumed")
  func endedStreamIsNotResumed() throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let session = RecordingSession(index: index, encoder: makeEncoder(root), clock: SystemClock())
    session.beginLiveSession(streaming: true, isLive: { true })
    // The 410: the host clears the streaming half as a deliberate stop does.
    session.endLiveSession(streaming: true, stillLive: false)
    #expect(try LiveSessionResume.plan(index: index, now: SystemClock().now, limit: 3_600) == nil)
  }

  private func makeRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("recording-session-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func makeEncoder(_ root: URL) -> ProgramEncoder {
    ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      settings: ProgrammeSettings(Self.settings.programme),
      directory: root
    )
  }

  /// Pictures and sound at real time, as the programme clock and the mix give them.
  private func feed(_ encoder: ProgramEncoder, seconds: Int) async throws {
    let factory = try #require(PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA))
    let buffer = try #require(factory.makeBuffer())
    let format = try #require(
      AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(
          sampleRate: AudioMixer.sampleRate,
          channels: UInt32(AudioMixer.channelCount)
        )
      )
    )
    let silence = [Int16](repeating: 0, count: Int(AudioMixer.sampleRate / 30) * AudioMixer.channelCount)
    let clock = SystemClock()
    for frame in 0 ..< seconds * 30 {
      let now = clock.now
      encoder.append(
        buffer,
        presentationTime: CMTime(value: CMTimeValue(frame), timescale: 30),
        captureWall: now,
        onClockGrid: true
      )
      let time = CMTime(value: CMTimeValue(frame), timescale: 30)
      if let sound = AudioSampleBuilder.makeSampleBuffer(
        samples: silence, formatDescription: format, presentationTime: time
      ) {
        encoder.append(audio: AudioFrame(sourceID: SourceID("mix"), sampleBuffer: sound, wallClock: now))
      }
      try await Task.sleep(nanoseconds: 33_000_000)
    }
    try await Task.sleep(nanoseconds: 500_000_000)
  }
}
