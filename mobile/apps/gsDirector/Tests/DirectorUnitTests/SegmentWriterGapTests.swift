import AVFoundation
import CoreMedia
import Foundation
import Testing
import DirectorCore
import DirectorDVR
import DirectorPipeline
import DirectorSources

/// Gap filling has never been exercised by the device harness. `set-video?on=false` blanks the
/// picture and `set-send-delay` holds frames without breaking the timeline, so neither produces the
/// one thing the fill exists for: a break in delivery. Terminating the Cameraman process does
/// produce one, and it kills the Director during finalisation — which is the crash this suite is
/// the unit-level half of.
///
/// These tests also serve as the positive control the device runs could not give. `archiveFillEvents`
/// read zero through every recording made on the instrumented build, which is only evidence that the
/// fill did not run if the counter can be shown to move at all.
@Suite("Segment writer gaps")
struct SegmentWriterGapTests {
  @Test("A corroborated gap fills audio, and the fill counters move")
  func corroboratedGapFillsAudio() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    // Both clocks advance together, which is what a real dropout looks like: the camera kept
    // running while nothing arrived. A glitched timestamp would move only the media clock.
    try harness.feed(writer, from: 1_006, seconds: 1)
    // `append` is asynchronous; without draining, every counter below reads zero because the queue
    // has not run yet. `finish()` also exercises finalisation, which is where the device dies.
    await writer.finish()

    let snapshot = harness.telemetry.snapshot
    // Guard against a vacuous pass: if nothing was archived the fill counters are trivially zero
    // and every assertion below says nothing about the fill.
    #expect(writer.appendedFrameCount > 0, "no frames appended — the harness wrote nothing")
    let dvr = snapshot.dvr
    #expect(dvr.archiveFillEvents == 1)
    #expect(dvr.archiveFillPackets > 0)

    // 5 s of hole between the last frame of the first run and the first of the second.
    let covered = Double(dvr.archiveFillPackets) * 1024 / 48_000
    #expect(abs(covered - 5) < 0.25, "audio covered \(covered) s of a 5 s gap")
  }

  @Test("An uncorroborated gap is clamped and fills nothing")
  func uncorroboratedGapDoesNotFill() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    // The media clock jumps but capture time does not: a glitched timestamp, not a dropout.
    try harness.feed(writer, from: 1_006, seconds: 1, captureOffset: -5)
    await writer.finish()

    let snap = harness.telemetry.snapshot
    #expect(writer.appendedFrameCount > 0, "no frames appended — this pass would be vacuous")
    #expect(snap.dvr.archiveFillEvents == 0)
  }

  /// The failure reproduced on the device: kill the Cameraman, let it reconnect, stop. The RTP
  /// unwrapper restarts on reconnect, so every later frame arrives stamped earlier than the frame
  /// before the outage. The writer read that as a clock that "does not advance" and dropped every
  /// one — 755 frames on a 55 s outage — then hung finalisation on a video track that stopped where
  /// the audio did not. After a reconnect there is also no capture-clock anchor yet, so the only
  /// corroboration available is arrival time.
  @Test("A clock that restarts after a reconnect is re-based, filled, and keeps archiving", .timeLimit(.minutes(1)))
  func reconnectRestartsClockAndKeepsArchiving() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    // 59 s later on the wall, the camera is back: its media clock restarted at 5 s and it has no
    // capture time until a new sender report anchors it.
    try harness.feed(writer, from: 1_060, media: 5, seconds: 1, capture: false)
    await writer.finish()

    let dvr = harness.telemetry.snapshot.dvr
    #expect(writer.appendedFrameCount >= 58, "appended \(writer.appendedFrameCount) of 60 frames")
    #expect(writer.droppedFrameCount == 0, "dropped \(writer.droppedFrameCount) frames after the reconnect")
    #expect(dvr.archiveClockRebases == 1)
    #expect(dvr.archiveFillEvents == 1)
    let covered = Double(dvr.archiveFillPackets) * 1024 / 48_000
    #expect(abs(covered - 59) < 0.5, "audio covered \(covered) s of a 59 s outage")
    // Generating the fill is not writing it. The invariant that keeps finalisation alive is that
    // the audio track reaches where the video track ends, and that nothing queued was thrown away.
    let tile = harness.telemetry.snapshot.tiles[0]
    #expect(tile.audioBuffersDiscarded == 0, "\(tile.audioBuffersDiscarded) audio buffers discarded")
    #expect(
      abs(tile.archiveAudioSeconds - tile.archiveVideoSeconds) < 0.5,
      "audio ends at \(tile.archiveAudioSeconds) s, video at \(tile.archiveVideoSeconds) s"
    )
  }

  /// The fill is capped at 4 000 packets — about 85 s — while the video sample keeps its full
  /// corroborated duration. A segmented writer will not finalise until every track reaches the
  /// boundary, so above the cap the tracks diverge by the remainder and stop hangs. That is the
  /// failure reproduced on the device: kill the Cameraman, restore it, stop, and the app dies
  /// during finalisation.
  @Test("Audio covers the video across a gap longer than the fill cap", .timeLimit(.minutes(1)))
  func longGapKeepsTracksTogether() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    try harness.feed(writer, from: 1_121, seconds: 1)
    // If the tracks end apart this is where a segmented writer stalls, so the time limit is part of
    // the assertion: a hang here is the device crash, reproduced in-process.
    await writer.finish()

    let dvr = harness.telemetry.snapshot.dvr
    #expect(dvr.archiveFillEvents == 1)

    let covered = Double(dvr.archiveFillPackets) * 1024 / 48_000
    // The invariant is that the tracks end together, not that the whole gap survives. The fill is
    // capped at 4 000 packets (85.33 s), and above that the video sample is clamped to match, so a
    // longer gap is deliberately shortened rather than left to hang finalisation.
    #expect(
      covered >= dvr.archiveFillLastGapSeconds - 0.25,
      "audio covered \(covered) s while the video sample kept \(dvr.archiveFillLastGapSeconds) s; the tracks end apart and stop hangs"
    )
    // And the shortening is real: say so here so a green test is not read as "no time lost".
    #expect(
      dvr.archiveFillLastGapSeconds <= 85.34,
      "a 120 s gap should be clamped to the fill cap, not kept whole"
    )
  }
}

private final class GapHarness {
  let root: URL
  let archives: URL
  let source = SourceID("gap-cam")
  let index: ArchiveIndex
  let clock = GapClock(1_000)
  let telemetry = PipelineTelemetry()
  let recordingID: Int64
  private let filler = ArchiveFiller(width: 160, height: 120, codec: .h264, frameRate: 30)
  private var frameID: UInt64 = 0

  init() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gap-\(UUID().uuidString)", isDirectory: true)
    archives = root.appendingPathComponent("archives", isDirectory: true)
    try FileManager.default.createDirectory(at: archives, withIntermediateDirectories: true)
    index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
  }

  func tearDown() {
    try? FileManager.default.removeItem(at: root)
  }

  func makeWriter() -> SegmentWriter {
    SegmentWriter(
      sourceID: source,
      sourceIndex: 0,
      recordingID: recordingID,
      index: index,
      telemetry: telemetry,
      settings: SegmentWriterSettings(segmentSeconds: 3, includesAudio: true),
      clock: clock,
      directory: archives
        .appendingPathComponent(source.slug, isDirectory: true)
        .appendingPathComponent("rec-\(recordingID)", isDirectory: true)
    )
  }

  /// Feeds `seconds` of 30 fps video with audio alongside it. `captureOffset` shifts capture time
  /// away from media time, which is how a glitched timestamp is told from a real dropout.
  func feed(
    _ writer: SegmentWriter,
    from start: Double,
    media mediaStart: Double? = nil,
    seconds: Double,
    captureOffset: Double = 0,
    capture: Bool = true
  ) throws {
    guard let buffer = Self.buffer(width: 160, height: 120) else {
      throw CocoaError(.fileWriteUnknown)
    }
    let fps = 30
    let frames = max(Int((seconds * Double(fps)).rounded(.down)), 1)
    for step in 0..<frames {
      let wall = start + Double(step) / Double(fps)
      // Media time normally tracks wall time. A reconnect restarts it, which is what `media` models.
      let mediaSeconds = (mediaStart ?? start) + Double(step) / Double(fps)
      let time = CMTime(seconds: mediaSeconds, preferredTimescale: 90_000)
      clock.set(wall)
      frameID += 1
      // Audio first: a writer with no audio format yet refuses video, because a file that gets a
      // video track and never an audio one never rotates a segment.
      if let silence = filler.encodeSilence(
        sourceID: source,
        presentationTime: time,
        wallClock: WallClock(seconds: wall)
      ) {
        writer.append(audio: silence)
      }
      guard
        let coded = filler.encode(
          pixelBuffer: buffer,
          sourceID: source,
          presentationTime: time,
          wallClock: WallClock(seconds: wall),
          frameID: frameID,
          forceKeyframe: step == 0
        )
      else { continue }
      writer.append(
        CompressedFrame(
          sourceID: coded.sourceID,
          codec: coded.codec,
          data: coded.data,
          parameterSets: coded.parameterSets,
          isKeyframe: coded.isKeyframe,
          presentationTime: coded.presentationTime,
          decodeTime: coded.decodeTime,
          wallClock: coded.wallClock,
          captureWallClock: capture ? WallClock(seconds: wall + captureOffset) : nil,
          frameID: coded.frameID
        )
      )
    }
  }

  private static func buffer(width: Int, height: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_32BGRA,
      [kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any]] as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    if let base = CVPixelBufferGetBaseAddress(buffer) {
      memset(base, 0x40, CVPixelBufferGetBytesPerRow(buffer) * height)
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }
}

private final class GapClock: DirectorClock, @unchecked Sendable {
  private let lock = NSLock()
  private var wall: WallClock

  init(_ seconds: Double) {
    wall = WallClock(seconds: seconds)
  }

  var now: WallClock {
    lock.lock()
    defer { lock.unlock() }
    return wall
  }

  func set(_ seconds: Double) {
    lock.lock()
    wall = WallClock(seconds: seconds)
    lock.unlock()
  }
}
