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

  /// After loss the archive keeps nothing until the next keyframe, so the picture after a dropout
  /// opens a new segment, and the picture held across the hole is the last sample of its file.
  @Test("A picture held across a gap keeps its length when the next picture opens a segment")
  func heldPictureSurvivesTheCut() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    // The next run starts on a keyframe past the 3 s boundary, so it opens the second segment.
    try harness.feed(writer, from: 1_006, seconds: 1)
    await writer.finish()

    let records = try harness.index.segments(forRecording: harness.recordingID)
      .filter { !$0.isInitialization }
      .sorted { $0.sequence < $1.sequence }
    #expect(records.count >= 2, "segments: \(records.map(\.filename))")
    let first = try #require(records.first)
    let url = harness.archives.appendingPathComponent(harness.source.slug, isDirectory: true)
      .appendingPathComponent(first.filename)
    let track = try #require(try await AVURLAsset(url: url).loadTracks(withMediaType: .video).first)
    let video = try await track.load(.timeRange).duration.seconds
    #expect(abs(video - 6) < 0.1, "first segment's picture runs \(video) s; it should hold across the 5 s hole to 6 s")
    #expect(abs(first.duration - video) < 0.1, "index says \(first.duration) s, the file holds \(video) s")
  }

  /// rec-408: 2% loss kept the Pixel's archive empty for 40 s, and the writer judged the hole a
  /// glitch, so the picture before it kept one frame's length. The index still said that segment
  /// ran to the keyframe after the hole, 42.7 s against a 2.5 s file, and the export left 40 s with
  /// no picture at all and scaled a keyframe group into a sliver behind it.
  @Test("A glitched gap leaves each segment recorded as long as its file, not as long as the gap")
  func clampedGapKeepsTheIndexHonest() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    try harness.feed(writer, from: 1_006, seconds: 1, captureOffset: -5)
    await writer.finish()

    let records = try harness.index.segments(forRecording: harness.recordingID)
      .filter { !$0.isInitialization }
      .sorted { $0.sequence < $1.sequence }
    #expect(!records.isEmpty)
    // Capture time says the glitch took no time, so the pictures sit back to back: whichever path
    // takes it out, re-based at intake or clamped at the write, no segment may claim the gap.
    var pictures = 0.0
    for record in records {
      let url = harness.archives.appendingPathComponent(harness.source.slug, isDirectory: true)
        .appendingPathComponent(record.filename)
      let track = try #require(try await AVURLAsset(url: url).loadTracks(withMediaType: .video).first)
      let video = try await track.load(.timeRange).duration.seconds
      pictures += video
      #expect(abs(record.duration - video) < 0.05, "index says \(record.duration) s for \(record.filename), the file holds \(video) s")
    }
    #expect(pictures < 2.5, "the pictures run \(pictures) s; the glitch should have added nothing")
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

  /// A camera on a starved link drops to its next keyframe and sends it as soon as the backlog
  /// drains, so across a real dropout the pictures on either side can arrive a fraction of a second
  /// apart. Judged on arrival, rec-410's Pixel took a 3.65 s drop for a glitch and placed the next
  /// second of pictures 3.35 s early; its capture time said all along that the time had passed.
  @Test("A dropout that arrives quickly is still held at the length its capture time says", .timeLimit(.minutes(1)))
  func captureTimeOutranksArrivalAcrossADropout() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    // 3.65 s of pictures never sent; the next one arrives 0.3 s after the last, but its media and
    // capture clocks both say 3.65 s.
    try harness.feed(writer, from: 1_001.3, media: 1_004.65, seconds: 1, captureOffset: 3.35)
    await writer.finish()

    let dvr = harness.telemetry.snapshot.dvr
    #expect(writer.appendedFrameCount >= 58, "appended \(writer.appendedFrameCount) of 60 frames")
    #expect(dvr.archiveClockRebases == 0, "a corroborated dropout was re-based onto its arrival time")
    #expect(dvr.archiveFillEvents == 1)
    let covered = Double(dvr.archiveFillPackets) * 1024 / 48_000
    #expect(abs(covered - 3.65) < 0.3, "audio covered \(covered) s of a 3.65 s dropout")
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
    // A two-minute outage is an ordinary one — a phone that crashed and was reopened — and it must
    // survive whole. The first real recording with one lost 35 s to a cap of 85 s.
    #expect(abs(covered - 120) < 0.5, "audio covered \(covered) s of a 120 s outage")
    #expect(abs(dvr.archiveFillLastGapSeconds - 120) < 0.5, "video held \(dvr.archiveFillLastGapSeconds) s of a 120 s outage")
  }

  /// The 120 s device run: all four exports the same length, the app survives the stop — and the
  /// reconnected camera's audio track ends exactly where the fill ends, with nothing archived after
  /// it came back. At 59 s the tracks agreed to within 40 ms. This drives the same shape in-process.
  @Test("After a two-minute reconnect gap, live audio keeps landing alongside the video", .timeLimit(.minutes(2)))
  func longReconnectGapKeepsArchivingAudio() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 2)
    try harness.feed(writer, from: 1_122, media: 5, seconds: 8, capture: false)
    await writer.finish()

    let tile = harness.telemetry.snapshot.tiles[0]
    #expect(writer.droppedFrameCount == 0)
    #expect(tile.audioBuffersDiscarded == 0)
    #expect(
      abs(tile.archiveAudioSeconds - tile.archiveVideoSeconds) < 0.5,
      "audio last placed at \(tile.archiveAudioSeconds) s, video at \(tile.archiveVideoSeconds) s"
    )
  }

  /// Beyond the cap the tracks are clamped together rather than left apart; a green test here
  /// must not be read as "no time lost" — above ~640 s the recording is deliberately shortened.
  @Test("Beyond the fill cap the video sample is clamped to the audio, and the tracks still end together", .timeLimit(.minutes(2)))
  func beyondCapClampsTogether() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feed(writer, from: 1_000, seconds: 1)
    try harness.feed(writer, from: 1_701, seconds: 1)
    await writer.finish()

    let dvr = harness.telemetry.snapshot.dvr
    let covered = Double(dvr.archiveFillPackets) * 1024 / 48_000
    #expect(covered >= dvr.archiveFillLastGapSeconds - 0.25, "audio \(covered) s vs video hold \(dvr.archiveFillLastGapSeconds) s")
    #expect(dvr.archiveFillLastGapSeconds < 700, "a 700 s gap should be clamped to the cap, not kept whole")
    let tile = harness.telemetry.snapshot.tiles[0]
    #expect(tile.audioBuffersDiscarded == 0)
  }

  /// rec-403: a Pixel under thermal throttling delivered its audio one to two seconds behind its
  /// picture. Each segment was closed on its keyframe before the audio for its last stretch had
  /// arrived, and that audio then had nowhere to go: 39 holes, 83 s of the Pixel's sound, every one
  /// straddling a segment boundary.
  @Test("Audio that arrives well behind its picture still lands in the segment it belongs to", .timeLimit(.minutes(1)))
  func lateAudioStaysInItsSegment() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    // On time for the first two seconds, which is where the recording pins its audio to its
    // picture, then a second and a half behind: rec-403's Pixel was fine until it throttled.
    try harness.feedLateAudio(writer, from: 1_000, seconds: 10, audioLag: 1.5, after: 2)
    await writer.finish()

    let files = try harness.segmentFiles()
    try #require(files.count >= 3, "expected several 3 s segments, got \(files.count)")
    // The last segment's tail depends on how finishing treats audio still owed; every other one is
    // closed mid-recording, which is where the audio went missing.
    for file in files.dropLast() {
      let asset = AVURLAsset(url: file)
      let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
      let audio = try #require(try await asset.loadTracks(withMediaType: .audio).first)
      let videoRange = try await video.load(.timeRange)
      let audioRange = try await audio.load(.timeRange)
      #expect(
        audioRange.end.seconds >= videoRange.end.seconds - 0.1,
        "\(file.lastPathComponent): audio ends at \(audioRange.end.seconds) s, video at \(videoRange.end.seconds) s"
      )
      #expect(audioRange.start.seconds <= 0.1, "\(file.lastPathComponent): audio starts at \(audioRange.start.seconds) s")
    }
    // Late is not wrong: the source clock placed every buffer, so none should have been moved.
    #expect(harness.telemetry.snapshot.tiles[0].audioResyncs == 0)
  }

  /// rec-405: after two minutes the Pixel's sound came out of the export 0.3–1.6 s early and full of
  /// holes, which is what a sample count that falls behind real time looks like to a receiver with
  /// nothing else to go on. With a capture time on every packet, the archive places it correctly.
  @Test("Audio whose sample clock loses time is placed by its capture time", .timeLimit(.minutes(1)))
  func captureTimeOutranksLostSamples() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter()
    try writer.prepare()
    try harness.feedLateAudio(
      writer, from: 1_000, seconds: 10, audioLag: 0, after: 0, samplesLost: (at: 4, seconds: 0.5)
    )
    await writer.finish()

    let files = try harness.segmentFiles()
    try #require(files.count >= 3, "expected several 3 s segments, got \(files.count)")
    for file in files.dropLast() {
      let asset = AVURLAsset(url: file)
      let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
      let audio = try #require(try await asset.loadTracks(withMediaType: .audio).first)
      let videoEnd = try await video.load(.timeRange).end.seconds
      let audioEnd = try await audio.load(.timeRange).end.seconds
      #expect(abs(audioEnd - videoEnd) < 0.1, "\(file.lastPathComponent): audio ends at \(audioEnd) s, video at \(videoEnd) s")
    }
    let tile = harness.telemetry.snapshot.tiles[0]
    #expect(tile.audioResyncs == 0)
    #expect(tile.audioRejectedPlacement < 5, "rejected \(tile.audioRejectedPlacement)")
  }

  /// This bench's Pixel was still reconnecting when a recording began, 25 s after the Director
  /// relaunched. Its writer was made before it had sent any audio, so it got no audio track, and
  /// every one of its 14,311 audio packets for the next fifteen minutes was turned away.
  @Test("A camera whose audio starts after the recording does gets it from the next segment on", .timeLimit(.minutes(1)))
  func audioThatStartsLateJoinsTheNextSegment() async throws {
    let harness = try GapHarness()
    defer { harness.tearDown() }

    let writer = harness.makeWriter(
      settings: SegmentWriterSettings(segmentSeconds: 3, includesAudio: false, acceptsLateAudio: true)
    )
    try writer.prepare()
    try harness.feedLateAudio(writer, from: 1_000, seconds: 10, audioLag: 0, after: 0, audioFrom: 2.5)
    await writer.finish()

    let files = try harness.segmentFiles()
    try #require(files.count >= 3, "expected several 3 s segments, got \(files.count)")
    var withAudio: [String] = []
    for file in files where try await !AVURLAsset(url: file).loadTracks(withMediaType: .audio).isEmpty {
      withAudio.append(file.lastPathComponent)
    }
    #expect(!withAudio.contains(files[0].lastPathComponent), "the first segment predates the camera's audio")
    #expect(
      withAudio.count >= files.count - 2,
      "segments with audio: \(withAudio) of \(files.map(\.lastPathComponent))"
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

  func makeWriter(
    settings: SegmentWriterSettings = SegmentWriterSettings(segmentSeconds: 3, includesAudio: true)
  ) -> SegmentWriter {
    SegmentWriter(
      sourceID: source,
      sourceIndex: 0,
      recordingID: recordingID,
      index: index,
      telemetry: telemetry,
      settings: settings,
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

  /// Feeds `seconds` of 30 fps video whose audio arrives on time until `after` seconds in and
  /// `audioLag` seconds behind it from then on. The audio runs at its own packet cadence on the
  /// source clock; whatever is still owed at the end is delivered then, as a camera catching up would.
  /// With `audioFrom`, the camera sends no audio at all before that many seconds in.
  func feedLateAudio(
    _ writer: SegmentWriter,
    from start: Double,
    seconds: Double,
    audioLag: Double,
    after lagStart: Double,
    audioFrom: Double = 0,
    samplesLost: (at: Double, seconds: Double)? = nil
  ) throws {
    guard let buffer = Self.buffer(width: 160, height: 120) else {
      throw CocoaError(.fileWriteUnknown)
    }
    let fps = 30
    let frames = Int((seconds * Double(fps)).rounded(.down))
    let packet = filler.audioDuration.seconds
    var audioTime = audioFrom
    func sendAudio(upTo limit: Double) {
      while audioTime <= limit {
        // With `samplesLost`, the camera's sample count falls that far behind real time at that
        // point, and says so through a capture time on every packet, as Cameraman now does.
        let lost = samplesLost.map { audioTime >= $0.at ? $0.seconds : 0 } ?? 0
        if let silence = filler.encodeSilence(
          sourceID: source,
          presentationTime: CMTime(seconds: audioTime - lost, preferredTimescale: 90_000),
          wallClock: clock.now
        ) {
          writer.append(audio: samplesLost == nil ? silence : CompressedAudioFrame(
            sourceID: silence.sourceID,
            data: silence.data,
            magicCookie: silence.magicCookie,
            sampleRate: silence.sampleRate,
            channelCount: silence.channelCount,
            presentationTime: silence.presentationTime,
            wallClock: silence.wallClock,
            captureWallClock: WallClock(seconds: start + audioTime)
          ))
        }
        audioTime += packet
      }
    }
    for step in 0..<frames {
      let offset = Double(step) / Double(fps)
      let wall = start + offset
      clock.set(wall)
      frameID += 1
      // The writer has to have seen audio before it takes any video, so the first packet is on
      // time; everything after it is late.
      if offset >= audioFrom {
        sendAudio(upTo: step == 0 ? 0 : offset - (offset < lagStart ? 0 : audioLag))
      }
      guard
        let coded = filler.encode(
          pixelBuffer: buffer,
          sourceID: source,
          presentationTime: CMTime(seconds: offset, preferredTimescale: 90_000),
          wallClock: WallClock(seconds: wall),
          frameID: frameID,
          forceKeyframe: step % fps == 0
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
          captureWallClock: WallClock(seconds: wall),
          frameID: coded.frameID
        )
      )
    }
    sendAudio(upTo: seconds)
  }

  /// The segment files this harness's writer produced, in order.
  func segmentFiles() throws -> [URL] {
    let directory = archives
      .appendingPathComponent(source.slug, isDirectory: true)
      .appendingPathComponent("rec-\(recordingID)", isDirectory: true)
    return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "mp4" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
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
