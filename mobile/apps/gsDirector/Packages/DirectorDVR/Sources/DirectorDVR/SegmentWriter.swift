import AVFoundation
import CoreMedia
import Darwin
import Foundation
import DirectorCore
import DirectorPipeline
import DirectorSources
import UniformTypeIdentifiers

public struct SegmentWriterSettings: Sendable, Equatable {
  /// How much video a segment holds. Boundaries land on the camera's own keyframes, so a segment is
  /// this long rounded up to the next one.
  public var segmentSeconds: Double
  public var includesAudio: Bool
  public var minimumFreeDiskBytes: Int64

  public init(
    segmentSeconds: Double = 3,
    includesAudio: Bool = true,
    minimumFreeDiskBytes: Int64 = 4 * 1024 * 1024 * 1024
  ) {
    self.segmentSeconds = segmentSeconds
    self.includesAudio = includesAudio
    self.minimumFreeDiskBytes = minimumFreeDiskBytes
  }

  public static func from(
    config: AppConfig,
    includesAudio: Bool = true
  ) -> SegmentWriterSettings {
    SegmentWriterSettings(
      segmentSeconds: config.segmentSeconds,
      includesAudio: includesAudio,
      minimumFreeDiskBytes: config.minimumFreeDiskBytes
    )
  }
}

public enum SegmentWriterError: Error, CustomStringConvertible {
  case notStarted
  case writerFailed(String)
  case diskFull(Int64)
  /// The camera changed codec or resolution mid-recording, which no single fMP4 track can hold.
  case formatChanged

  public var description: String {
    switch self {
    case .notStarted: "segment writer has not started"
    case let .writerFailed(reason): "asset writer failed: \(reason)"
    case let .diskFull(free): "disk headroom exhausted (\(free) bytes free)"
    case .formatChanged: "camera changed format mid-recording"
    }
  }
}

/// One camera's archive: the bytes it sent, muxed into segmented fMP4 and nothing else.
///
/// There is no encoder here and no scaling. A camera's own H.264 or H.265 access units and its own
/// AAC go into the file as they came off the socket, so the recording is the camera's full quality
/// by construction and costs no encode session at all. The only encode left in the app is the
/// single programme master, which has to be encoded because it is a composite that exists nowhere
/// on the wire.
///
/// Two AVFoundation constraints shape the implementation, both established by measurement rather
/// than documentation:
///
/// - Passthrough of a video *and* an audio track is refused outright when
///   `preferredOutputSegmentInterval` is a positive time (`-11875`). Custom segmentation —
///   `.indefinite` plus `flushSegment()` before a sync sample — accepts both, so that is how
///   segments are cut, on the camera's own keyframes.
/// - In fragmented MP4 the per-sample durations *are* the timeline, and a sample with no duration
///   is refused (`-16364`). RTP gives timestamps, not durations, so each picture is held until its
///   successor arrives and then written with the exact gap between them. The archive therefore runs
///   one frame behind the socket, which is 33 ms of a recording nobody is watching live.
public final class SegmentWriter: NSObject, ArchiveSink, @unchecked Sendable {
  /// Called when the camera's format changed under an open recording, which needs a fresh writer.
  public typealias FormatChangeHandler = @Sendable (SourceID) -> Void

  /// Roughly two seconds of audio at the buffer sizes cameras send.
  /// Above the silent-fill cap (30 000 packets, ~640 s) with room for live audio queued behind it.
  /// At 200 a fill for a 38 s outage — 1 775 packets written in one burst — overflowed this and
  /// 1 575 of them were discarded, so the audio track ended 33 s short of the video sample it was
  /// written to cover and finalisation hung on the very divergence the fill exists to prevent.
  private static let maximumPendingAudio = 32_000
  /// A gap longer than this is a clock glitch rather than lost frames, and giving one sample a
  /// duration that long would stretch the whole timeline.
  private static let maximumFrameDuration: Double = 2

  public let sourceID: SourceID
  public let sourceIndex: Int
  public let settings: SegmentWriterSettings

  private let directory: URL
  private let recordingID: Int64
  private let index: ArchiveIndex
  private let telemetry: PipelineTelemetry
  private let clock: DirectorClock
  private let onFormatChange: FormatChangeHandler?
  /// Appends are serialised here so that they leave the camera's receive thread: a file write must
  /// never be what delays reading the next packet.
  private let queue: DispatchQueue

  private let lock = NSLock()
  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  private var started = false
  private var finishing = false
  private var superseded = false

  private var videoFormat: CMVideoFormatDescription?
  private var videoParameterSets: [Data] = []
  private var audioFormat: CMAudioFormatDescription?
  /// The picture waiting for its successor to reveal how long it lasts.
  private var held: HeldPicture?
  private var basePresentationTime: CMTime?
  private var baseWallClock: WallClock?
  private var lastVideoTime: CMTime = .negativeInfinity
  private var lastVideoDuration = CMTime(value: 3000, timescale: 90_000)
  /// Added to every incoming presentation time so the file's timeline survives the camera's clock
  /// restarting. A reconnect resets the RTP unwrapper, and every frame after it arrived stamped
  /// earlier than the frame before the outage; the writer read that as "does not advance" and
  /// dropped every one of them for the rest of the recording — 755 frames on a 55 s outage — and
  /// then could not finalise a file whose video stopped where its audio did not.
  private var timelineOffset: CMTime = .zero
  /// Seconds of wall clock this archive covers with a held picture rather than a delivered frame.
  /// Nonzero means the camera lost time and the file kept it rather than closing over it.
  private var archiveGapSeconds: Double = 0
  /// Generates silent AAC matching this camera's audio format, built once the first real audio
  /// frame reveals what that format is.
  ///
  /// Video held across a gap without audio to match is what hangs finalisation: a segmented writer
  /// will not finish until every track reaches the boundary, so a video track running six seconds
  /// past its audio never completes and the app is killed for not responding.
  private var silence: ArchiveFiller?
  /// Sub-packet remainder carried between gaps so the audio track does not drift short of video.
  private var silenceResidualSeconds: Double = 0
  private var silenceSampleRate: Double = 0
  private var silenceChannels: Int = 0
  private var boundary = SegmentBoundary(interval: 6)
  private var audioTimeline = ArchiveAudioTimeline()
  /// Audio waiting for the writer to accept it.
  ///
  /// Discarding a buffer because `isReadyForMoreMediaData` was false is not survivable: the audio
  /// track then covers less of the timeline than the video track, a segmented writer will not
  /// rotate a segment until every track reaches the boundary, and the video input goes permanently
  /// unready in response. Dropping one audio buffer therefore costs all subsequent video.
  private var pendingAudio: [CMSampleBuffer] = []
  /// Only one thread drains at a time; `AVAssetWriterInput.append` is not safe from two.
  private var isDraining = false
  private var sequence = 0
  /// Destination of the writer currently open. File-based so AVAssetWriter does not accumulate
  /// fragment `Data` in RAM until `finishWriting`.
  private var outputFilename: String?
  private var pendingFirstFrameID: UInt64?
  private var droppedFrames: UInt64 = 0
  private var appendedFrames: UInt64 = 0
  private var stopError: Error?

  private struct HeldPicture {
    let data: Data
    let presentationTime: CMTime
    let isKeyframe: Bool
    let frameID: UInt64
    /// When the camera took this picture, on the Director's clock. Nil until its sender reports
    /// have established an anchor. Only the first picture of a segment uses it, to record where
    /// that segment starts.
    let captureWallClock: WallClock?
    /// When this picture reached the Director. Always present, and unlike capture time it survives a
    /// reconnect, so it is what corroborates a gap when the camera's clock anchor has been lost.
    let wallClock: WallClock
  }

  public init(
    sourceID: SourceID,
    sourceIndex: Int,
    recordingID: Int64,
    index: ArchiveIndex,
    telemetry: PipelineTelemetry,
    settings: SegmentWriterSettings,
    clock: DirectorClock,
    directory: URL? = nil,
    onFormatChange: FormatChangeHandler? = nil
  ) {
    self.sourceID = sourceID
    self.sourceIndex = sourceIndex
    self.recordingID = recordingID
    self.index = index
    self.telemetry = telemetry
    self.settings = settings
    self.clock = clock
    self.onFormatChange = onFormatChange
    self.directory = directory ?? DirectorPaths.archiveDirectory(for: sourceID)
      .appendingPathComponent("rec-\(recordingID)", isDirectory: true)
    self.queue = DispatchQueue(
      label: "co.gamestation.director.dvr.\(sourceID.slug)",
      qos: .userInitiated
    )
    boundary = SegmentBoundary(interval: settings.segmentSeconds)
  }

  public var appendedFrameCount: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return appendedFrames
  }

  public var droppedFrameCount: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return droppedFrames
  }

  public var lastError: Error? {
    lock.lock()
    defer { lock.unlock() }
    return stopError
  }

  /// Whether anything has actually been written yet. False while waiting for the camera's first
  /// keyframe, which is up to one keyframe interval after Record.
  public var isWriting: Bool {
    lock.lock()
    defer { lock.unlock() }
    return started
  }

  // MARK: - Lifecycle

  /// Prepares the destination. The `AVAssetWriter` itself cannot be built yet: passthrough inputs
  /// need the camera's format descriptions, which only the first access units carry.
  public func prepare() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    // Continue the recording's sequence rather than restarting at 0, which would REPLACE the
    // previous writer's init row (unique on recording/source/sequence) and overwrite its files.
    let next = ((try? index.maxSequence(for: sourceID, recordingID: recordingID)) ?? -1) + 1
    lock.lock()
    sequence = next
    lock.unlock()

    telemetry.mutateTile(sourceIndex) { $0.isArchiving = true }
  }

  /// Marks this writer as replaced by another for the same tile, so that closing it does not
  /// report the tile as no longer archiving when its successor already is.
  public func supersede() {
    lock.lock()
    superseded = true
    lock.unlock()
  }

  private func reportStopped() {
    lock.lock()
    let superseded = self.superseded
    lock.unlock()
    guard !superseded else { return }
    telemetry.mutateTile(sourceIndex) {
      $0.isArchiving = false
      $0.archiveHeight = 0
    }
  }

  public func finish() async {
    // The held picture is a real frame of the recording; without this the last one is lost every
    // time, and with a one-second keyframe interval that is visible at the cut.
    await onQueue { self.flushHeld() }

    // Before `beginFinish` sets the flag that stops the drain, or the tail of the audio track is
    // simply thrown away and the last segment ends with video the audio never reaches.
    //
    // Draining once is not enough. A writer that is mid-segment when the app backgrounds is often
    // not accepting audio at that instant, and giving up on the first refusal cost roughly nine
    // seconds off the end of the audio track in testing. Wait briefly for it to come back.
    await drainAudio(waitingUpTo: 2)

    guard let pending = beginFinish() else { return }

    // A writer that never got a frame never had `startSession` called, and `finishWriting` on
    // such a writer never returns. There is nothing to save in that case anyway.
    guard pending.hasSession else {
      pending.writer?.cancelWriting()
      clearWriter()
      reportStopped()
      return
    }

    pending.videoInput?.markAsFinished()
    pending.audioInput?.markAsFinished()
    // The completion-handler form, not `await writer.finishWriting()`: the latter resolves to
    // the synchronous overload, which blocks whatever thread calls it. Called from the main
    // actor that is exactly the thread the final segment's delegate callback needs.
    if let writer = pending.writer {
      await withCheckedContinuation { continuation in
        writer.finishWriting { continuation.resume() }
      }
      persistClosedFile(
        filename: pending.filename,
        sequence: pending.sequence,
        startWall: pending.startWall,
        duration: pending.duration,
        firstFrameID: pending.firstFrameID
      )
    }

    clearWriter()
    reportStopped()
  }

  // The lock is taken in these synchronous helpers because `NSLock.lock()` is unavailable
  // directly inside an async function.
  private struct PendingFinish {
    let writer: AVAssetWriter?
    let videoInput: AVAssetWriterInput?
    let audioInput: AVAssetWriterInput?
    let hasSession: Bool
    let filename: String?
    let sequence: Int
    let startWall: WallClock?
    let duration: TimeInterval
    let firstFrameID: UInt64?
  }

  private func beginFinish() -> PendingFinish? {
    lock.lock()
    defer { lock.unlock() }
    guard !finishing else { return nil }
    finishing = true
    return PendingFinish(
      writer: writer,
      videoInput: videoInput,
      audioInput: audioInput,
      hasSession: started,
      filename: outputFilename,
      sequence: sequence,
      startWall: baseWallClock,
      duration: lastVideoTime.seconds,
      firstFrameID: pendingFirstFrameID
    )
  }

  private func clearWriter() {
    lock.lock()
    defer { lock.unlock() }
    writer = nil
    videoInput = nil
    audioInput = nil
    outputFilename = nil
    started = false
    held = nil
    audioTimeline = ArchiveAudioTimeline()
    pendingAudio.removeAll()
  }

  private func onQueue(_ work: @escaping @Sendable () -> Void) async {
    await withCheckedContinuation { continuation in
      queue.async {
        work()
        continuation.resume()
      }
    }
  }

  // MARK: - Video

  public func append(_ frame: CompressedFrame) {
    queue.async { [weak self] in self?.write(video: frame) }
  }

  private func write(video frame: CompressedFrame) {
    lock.lock()
    guard !finishing, stopError == nil, !frame.data.isEmpty else {
      lock.unlock()
      return
    }
    if let writer, writer.status == .failed {
      let error = writer.error
      stopError = error
      lock.unlock()
      let detail = ProgramEncoder.describe(error)
      telemetry.recordError("archive \(sourceID.rawValue) failed: \(detail)")
      telemetry.mutateTile(sourceIndex) { $0.lastError = detail }
      return
    }

    // The camera repeats its parameter sets before every keyframe, so this is almost always a
    // no-op. When they genuinely change the track cannot continue and a new writer is needed.
    if videoParameterSets != frame.parameterSets {
      let hadFormat = videoFormat != nil
      guard let format = CompressedSample.videoFormatDescription(
        codec: frame.codec,
        parameterSets: frame.parameterSets
      ) else {
        lock.unlock()
        return
      }
      if hadFormat, let existing = videoFormat, !CMFormatDescriptionEqual(existing, otherFormatDescription: format) {
        stopError = SegmentWriterError.formatChanged
        lock.unlock()
        telemetry.recordError("\(sourceID.rawValue) changed format mid-recording; reopening archive")
        onFormatChange?(sourceID)
        return
      }
      videoParameterSets = frame.parameterSets
      videoFormat = format
    }

    guard videoFormat != nil else {
      lock.unlock()
      return
    }
    // Nothing can be written before the camera's audio has described itself, or the file would get
    // a video track and never an audio one. Audio arrives every 32 ms, so this costs a frame or two.
    if !started, settings.includesAudio, audioFormat == nil {
      lock.unlock()
      return
    }
    // A recording has to open on a keyframe: a segment starting mid-GOP is not decodable.
    if !started, held == nil, !frame.isKeyframe {
      lock.unlock()
      return
    }

    let previous = held
    var adjusted = CMTimeAdd(frame.presentationTime, timelineOffset)
    if let previous {
      let rawGap = CMTimeSubtract(adjusted, previous.presentationTime)
      let elapsed = frame.wallClock.seconds - previous.wallClock.seconds
      // The media clock is only trusted while it agrees with the time that actually passed. Going
      // backwards means the camera's clock restarted; a long jump that real elapsed time cannot
      // corroborate means it glitched. Either way the frame is placed where the wall clock says it
      // belongs — one frame on from the last if no time passed — so the file's timeline keeps
      // moving forward and a reconnect becomes an ordinary gap for the hold-and-fill path.
      let untrusted = !rawGap.isNumeric
        || rawGap < .zero
        || (rawGap.seconds > Self.maximumFrameDuration && abs(rawGap.seconds - elapsed) > 0.5)
      if untrusted {
        let step = max(elapsed, lastVideoDuration.isNumeric ? lastVideoDuration.seconds : 1.0 / 30)
        let desired = CMTimeAdd(
          previous.presentationTime,
          CMTime(seconds: step, preferredTimescale: 90_000)
        )
        timelineOffset = CMTimeAdd(timelineOffset, CMTimeSubtract(desired, adjusted))
        adjusted = desired
        telemetry.mutate { snapshot in
          snapshot.dvr.archiveClockRebases &+= 1
          snapshot.dvr.archiveLastRebaseElapsedSeconds = elapsed
        }
      }
    }
    held = HeldPicture(
      data: frame.data,
      presentationTime: adjusted,
      isKeyframe: frame.isKeyframe,
      frameID: frame.frameID,
      captureWallClock: frame.captureWallClock,
      wallClock: frame.wallClock
    )
    guard let previous else {
      lock.unlock()
      return
    }
    let gap = CMTimeSubtract(adjusted, previous.presentationTime)
    // The same interval measured on capture time, when both frames carry one. A real dropout moves
    // both clocks together; a glitched timestamp moves only the media clock.
    let captureGap: Double? = {
      guard let a = previous.captureWallClock, let b = frame.captureWallClock else { return nil }
      return b.seconds - a.seconds
    }()
    // The same interval measured on arrival. A dropout keeps the Director's clock running while
    // nothing comes in, so arrival moves with the media clock; a glitched timestamp moves the media
    // clock while frames keep arriving on time. This is the only corroboration available across a
    // reconnect, which is precisely when a real outage has just happened.
    let arrivalGap = frame.wallClock.seconds - previous.wallClock.seconds
    lock.unlock()

    appendVideo(previous, duration: gap, captureGap: captureGap, arrivalGap: arrivalGap)
  }

  /// Writes out the picture still being held, at the last known frame duration since there is no
  /// successor to measure against.
  /// Enough silent packets to cover `duration`, timed to run from `start`.
  ///
  /// Returns nothing until the camera has sent real audio, because the silence has to carry the
  /// same sample rate, channel count and magic cookie as the track it is joining — a packet that
  /// disagrees is worse than no packet.
  private func silenceFrames(
    covering duration: CMTime,
    startingAt start: CMTime,
    sourceID: SourceID
  ) -> (frames: [CompressedAudioFrame], covered: Double) {
    guard settings.includesAudio, silenceSampleRate > 0, silenceChannels > 0 else { return ([], 0) }
    if silence == nil {
      silence = ArchiveFiller(
        width: 2, height: 2,
        audioSampleRate: silenceSampleRate,
        audioChannels: silenceChannels
      )
    }
    guard let silence else { return ([], 0) }
    let step = silence.audioDuration
    guard step.isNumeric, step > .zero, duration.isNumeric, duration > .zero else { return ([], 0) }
    // The remainder that does not fill a whole packet is carried to the next gap rather than
    // dropped. A packet is 21.3 ms; discarding it each time leaves audio short of video by a little
    // every gap, and those accumulate over a long recording.
    let wanted = duration.seconds + silenceResidualSeconds
    var count = Int(wanted / step.seconds)
    silenceResidualSeconds = wanted - Double(count) * step.seconds
    guard count > 0 else { return ([], 0) }
    // A long gap is capped rather than abandoned. Returning nothing above a threshold left the
    // audio track short exactly when the gap was largest, which is the case that hangs
    // finalisation — the opposite of what this exists to do.
    // Ten and a half minutes at 48 kHz. The previous cap of 4 000 packets (85 s) was crossed by
    // the first real outage Paul recorded — a camera gone for two minutes — and everything past
    // it was clamped out of the recording, so the file ran 35 s short and the camera appeared
    // never to have come back. A frame here is a shared `Data` plus a timestamp; 30 000 of them
    // is a few megabytes, and a longer gap is still clamped to match rather than left to hang.
    let maximum = 30_000
    if count > maximum {
      count = maximum
      silenceResidualSeconds = 0
    }
    var frames: [CompressedAudioFrame] = []
    frames.reserveCapacity(count)
    var at = start
    for _ in 0 ..< count {
      guard let frame = silence.encodeSilence(
        sourceID: sourceID,
        presentationTime: at,
        wallClock: clock.now
      ) else { break }
      frames.append(frame)
      at = CMTimeAdd(at, step)
    }
    return (frames, Double(frames.count) * step.seconds)
  }

  private func flushHeld() {
    lock.lock()
    let previous = held
    held = nil
    let duration = lastVideoDuration
    lock.unlock()
    guard let previous else { return }
    appendVideo(previous, duration: duration)
  }

  private func appendVideo(
    _ picture: HeldPicture,
    duration: CMTime,
    captureGap: Double? = nil,
    arrivalGap: Double? = nil
  ) {
    lock.lock()
    guard !finishing, stopError == nil, let format = videoFormat else {
      lock.unlock()
      return
    }

    if !started {
      lock.unlock()
      guard startWriting(videoFormat: format) else { return }
      lock.lock()
    }
    guard let writer, let videoInput else {
      lock.unlock()
      return
    }

    if basePresentationTime == nil {
      basePresentationTime = picture.presentationTime
      // Capture time when the camera has given us one, arrival time until it does. Seek maps a
      // scrub target through this value, so taking it from arrival makes the same request land on a
      // different moment on every camera — each start carrying that camera's delivery delay on top
      // of its own keyframe phase.
      baseWallClock = picture.captureWallClock ?? clock.now
    }
    guard let base = basePresentationTime else {
      lock.unlock()
      return
    }

    let presentationTime = CMTimeSubtract(picture.presentationTime, base)
    guard presentationTime.isNumeric, presentationTime >= .zero else {
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: sourceIndex)
      return
    }
    // A timestamp that does not advance means the camera's clock reset. Passing it on would fail
    // the writer for the rest of the recording, so the frame is dropped instead.
    if started, presentationTime <= lastVideoTime {
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: sourceIndex)
      return
    }

    // A long gap is either a real dropout or a glitched timestamp, and collapsing both to one
    // frame is what shortens a recording: the missing time is simply discarded, so everything
    // after the hole sits that much early and every later seek is wrong. A camera that lost five
    // seconds used to contribute thirty-three milliseconds.
    //
    // Capture time settles which it is. A dropout advances the camera's wall clock by the same
    // interval as its media clock, because both kept running while nothing arrived. A glitched
    // timestamp moves only the media clock. So a gap corroborated by capture time is kept at its
    // full length, and only an uncorroborated one is clamped.
    var sampleDuration = duration
    // Capture time is the better witness when it exists. When it does not — the anchor is gone
    // after a reconnect — arrival time answers the same question, and refusing to ask it is what
    // made every real dropout read as a glitch and take the discard path.
    let corroborated = captureGap.map { abs($0 - duration.seconds) < 0.5 }
      ?? arrivalGap.map { abs($0 - duration.seconds) < 0.5 }
      ?? false
    let tooLong = sampleDuration.seconds > Self.maximumFrameDuration
    if !sampleDuration.isNumeric || sampleDuration <= .zero || (tooLong && !corroborated) {
      sampleDuration = lastVideoDuration
      if tooLong { telemetry.recordDroppedFrame(tile: sourceIndex) }
    }
    var silenceToWrite: [CompressedAudioFrame] = []
    if tooLong, corroborated {
      // Held at its true length so the file still spans the wall clock it covers. The picture
      // freezes for the duration of the hole, which is what a viewer should see: the alternative
      // is a recording that silently runs short.
      let fill = silenceFrames(
        covering: sampleDuration,
        startingAt: picture.presentationTime,
        sourceID: sourceID
      )
      silenceToWrite = fill.frames
      // The fill is capped, so above the cap the audio stops short. The video sample must stop with
      // it: a segmented writer will not finalise until every track reaches the boundary, so a video
      // sample that outruns its audio by the uncovered remainder hangs `finishWriting` and the app
      // is killed for not responding. Losing the tail of a very long gap is the lesser evil, and it
      // is recorded here rather than hidden.
      if fill.covered > 0, fill.covered < sampleDuration.seconds - 0.001 {
        sampleDuration = CMTime(seconds: fill.covered, preferredTimescale: 90_000)
      }
      archiveGapSeconds += sampleDuration.seconds
      // Reported so this branch can be seen from outside. It is supposed to be unreachable on a
      // healthy recording, and it is not: fill packets appear in takes whose video runs an unbroken
      // 30 fps. Without these counters the only evidence was the audible click in the exported file.
      let filled = silenceToWrite.count
      let gapSeconds = sampleDuration.seconds
      let observedCapture = captureGap ?? 0
      telemetry.mutate { snapshot in
        snapshot.dvr.archiveFillEvents &+= 1
        snapshot.dvr.archiveFillPackets &+= UInt64(filled)
        snapshot.dvr.archiveGapSeconds += gapSeconds
        snapshot.dvr.archiveFillLastGapSeconds = gapSeconds
        snapshot.dvr.archiveFillLastCaptureGap = observedCapture
      }
    }
    lastVideoDuration = sampleDuration
    lastVideoTime = presentationTime
    if pendingFirstFrameID == nil { pendingFirstFrameID = picture.frameID }

    // Segments are cut at the camera's keyframes, which is the only place a segment can start.
    let shouldFlush = picture.isKeyframe
      && boundary.shouldFlush(at: presentationTime.seconds, isKeyframe: true)
    let isReady = videoInput.isReadyForMoreMediaData
    lock.unlock()

    // Written straight after the picture it covers, so the audio track never trails the video by
    // more than the gap itself and finalisation is not left waiting on a track that stopped early.
    for frame in silenceToWrite { write(audio: frame) }
    // Push the whole burst through now rather than eight packets per call; a fill this size waits
    // for the input, and the queue only exists to survive a briefly unready one.
    if !silenceToWrite.isEmpty { drainAudio(limit: .max) }

    if shouldFlush {
      // Audio first, so the file being closed carries the sound that belongs to it.
      drainAudio(limit: .max)
      recycleWriter()
      // This keyframe opens the next file so the cut stays on a sync sample.
      appendVideo(picture, duration: duration)
      return
    }

    guard isReady else {
      lock.lock()
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: sourceIndex)
      return
    }

    guard let sampleBuffer = CompressedSample.videoSampleBuffer(
      data: picture.data,
      formatDescription: format,
      presentationTime: presentationTime,
      duration: sampleDuration,
      isKeyframe: picture.isKeyframe
    ) else {
      lock.lock()
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: sourceIndex)
      return
    }

    if videoInput.append(sampleBuffer) {
      lock.lock()
      appendedFrames &+= 1
      lock.unlock()
      let seconds = presentationTime.seconds
      telemetry.mutateTile(sourceIndex) { $0.archiveVideoSeconds = seconds }
      telemetry.recordArchivedFrame(tile: sourceIndex)
    } else {
      lock.lock()
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: sourceIndex)
    }

    // Small budget: audio's own arrival does the bulk, and this runs between video appends.
    drainAudio(limit: 2)
  }

  /// Builds the writer around the camera's formats. Called once, at the first keyframe.
  private func startWriting(videoFormat format: CMVideoFormatDescription) -> Bool {
    lock.lock()
    let audioFormat = self.audioFormat
    lock.unlock()

    lock.lock()
    sequence += 1
    let seq = sequence
    lock.unlock()
    let filename = String(format: "seg-%05d.mp4", seq)
    let url = directory.appendingPathComponent(filename)
    let writer: AVAssetWriter
    do {
      writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    } catch {
      recordStartFailure(.writerFailed(error.localizedDescription))
      return false
    }
    // Moov-at-front so instant replay can open the file without scanning to the end.
    writer.shouldOptimizeForNetworkUse = true

    let videoInput = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: nil,
      sourceFormatHint: format
    )
    videoInput.expectsMediaDataInRealTime = true
    guard writer.canAdd(videoInput) else {
      recordStartFailure(.writerFailed("writer rejected the video input"))
      return false
    }
    writer.add(videoInput)

    var audioInput: AVAssetWriterInput?
    if settings.includesAudio, let audioFormat {
      let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: nil,
        sourceFormatHint: audioFormat
      )
      input.expectsMediaDataInRealTime = true
      if writer.canAdd(input) {
        writer.add(input)
        audioInput = input
      }
    }

    guard writer.startWriting() else {
      recordStartFailure(.writerFailed(writer.error?.localizedDescription ?? "startWriting failed"))
      return false
    }
    writer.startSession(atSourceTime: .zero)

    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    lock.lock()
    self.writer = writer
    self.videoInput = videoInput
    self.audioInput = audioInput
    self.outputFilename = filename
    started = true
    lock.unlock()

    telemetry.mutateTile(sourceIndex) {
      $0.isArchiving = true
      $0.archiveHeight = Int(dimensions.height)
    }
    return true
  }

  /// Closes the current file-based writer so its compressed samples live on disk, not in RAM.
  /// The next keyframe opens a fresh writer; sequence numbers continue so index rows stay unique.
  private func recycleWriter() {
    lock.lock()
    guard !finishing, started, let flushed = writer else {
      lock.unlock()
      return
    }
    let videoInput = self.videoInput
    let audioInput = self.audioInput
    let filename = outputFilename
    let seq = sequence
    let startWall = baseWallClock
    let duration = lastVideoTime.isNumeric ? lastVideoTime.seconds : 0
    let firstFrameID = pendingFirstFrameID
    self.writer = nil
    self.videoInput = nil
    self.audioInput = nil
    self.outputFilename = nil
    started = false
    basePresentationTime = nil
    baseWallClock = nil
    lastVideoTime = .negativeInfinity
    pendingFirstFrameID = nil
    // Keep `held`. Recycle runs from appendVideo of the keyframe that *opens* the next file,
    // and `held` is already the picture after that keyframe. Clearing it dropped one frame
    // at every 3s cut. That frame belongs on the new file's timeline.
    pendingAudio.removeAll()
    isDraining = false
    audioTimeline = ArchiveAudioTimeline()
    boundary = SegmentBoundary(interval: settings.segmentSeconds)
    lock.unlock()

    videoInput?.markAsFinished()
    audioInput?.markAsFinished()
    flushed.finishWriting { [weak self] in
      self?.persistClosedFile(
        filename: filename,
        sequence: seq,
        startWall: startWall,
        duration: duration,
        firstFrameID: firstFrameID
      )
    }
  }

  private func persistClosedFile(
    filename: String?,
    sequence: Int,
    startWall: WallClock?,
    duration: TimeInterval,
    firstFrameID: UInt64?
  ) {
    guard let filename else { return }
    let url = directory.appendingPathComponent(filename)
    let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
    do {
      try index.insertSegment(
        recordingID: recordingID,
        sourceID: sourceID,
        sequence: sequence,
        filename: "rec-\(recordingID)/\(filename)",
        isInitialization: false,
        startWall: startWall ?? clock.now,
        duration: max(0, duration),
        byteCount: bytes,
        firstFrameID: firstFrameID
      )
      telemetry.recordSegment(bytes: UInt64(max(0, bytes)))
    } catch {
      telemetry.recordError("index write failed for \(filename): \(error)")
    }
    Self.dropFileCache(at: url)
  }

  /// Stops the kernel charging this process for the pages of a file we just closed. Without it,
  /// `phys_footprint` climbs in lock-step with archive bytes even though the writer has finished.
  private static func dropFileCache(at url: URL) {
    url.withUnsafeFileSystemRepresentation { path in
      guard let path else { return }
      let fd = open(path, O_RDONLY)
      guard fd >= 0 else { return }
      _ = fcntl(fd, F_NOCACHE, 1)
      _ = fsync(fd)
      close(fd)
    }
  }

  private func recordStartFailure(_ error: SegmentWriterError) {
    lock.lock()
    stopError = error
    lock.unlock()
    telemetry.recordError("archive \(sourceID.rawValue) failed: \(error.description)")
    telemetry.mutateTile(sourceIndex) { $0.lastError = error.description }
  }

  // MARK: - Audio

  public func append(audio frame: CompressedAudioFrame) {
    queue.async { [weak self] in self?.write(audio: frame) }
  }

  private func write(audio frame: CompressedAudioFrame) {
    telemetry.mutateTile(sourceIndex) { $0.audioReceived &+= 1 }
    lock.lock()
    guard !finishing, settings.includesAudio, stopError == nil else {
      lock.unlock()
      telemetry.mutateTile(sourceIndex) { $0.audioRejectedClosed &+= 1 }
      return
    }
    if silenceSampleRate != frame.sampleRate || silenceChannels != frame.channelCount {
      silenceSampleRate = frame.sampleRate
      silenceChannels = frame.channelCount
      silence = nil
    }
    if audioFormat == nil {
      audioFormat = CompressedSample.aacFormatDescription(
        magicCookie: frame.magicCookie,
        sampleRate: frame.sampleRate,
        channelCount: frame.channelCount
      )
    }
    // Audio cannot be placed on the timeline until video has established where "now" is. Before the
    // first video frame `lastVideoTime` is negative infinity, and anchoring against it yields an
    // infinite base that every later sample fails its guards, so the audio track stays empty for
    // the whole recording — and a segmented writer with one empty track never rotates a segment.
    guard started, let format = audioFormat, audioInput != nil, lastVideoTime.isNumeric else {
      lock.unlock()
      telemetry.mutateTile(sourceIndex) { $0.audioRejectedNotStarted &+= 1 }
      return
    }

    let placement = audioTimeline.place(
      sourceTime: frame.presentationTime,
      duration: frame.duration,
      videoTime: lastVideoTime
    )
    lock.unlock()

    guard let placement, placement.start.isNumeric, placement.start >= .zero else {
      telemetry.mutateTile(sourceIndex) { $0.audioRejectedPlacement &+= 1 }
      return
    }
    report(placement)

    guard let sampleBuffer = CompressedSample.audioSampleBuffer(
      data: frame.data,
      formatDescription: format,
      presentationTime: placement.start,
      duration: frame.duration
    ) else {
      telemetry.mutateTile(sourceIndex) { $0.audioRejectedBuild &+= 1 }
      return
    }

    lock.lock()
    pendingAudio.append(sampleBuffer)
    // A queue this deep means the writer has stopped consuming audio entirely, so the recording is
    // already lost. Bounding it keeps a stalled writer from growing without limit.
    if pendingAudio.count > Self.maximumPendingAudio {
      pendingAudio.removeFirst(pendingAudio.count - Self.maximumPendingAudio)
      telemetry.mutateTile(sourceIndex) { $0.audioBuffersDiscarded &+= 1 }
    }
    lock.unlock()

    drainAudio(limit: 8)
  }

  private func report(_ placement: ArchiveAudioTimeline.Placement) {
    guard placement.rejectedClock || placement.resynced || placement.drift != nil else { return }
    telemetry.mutateTile(sourceIndex) { tile in
      if placement.rejectedClock { tile.audioClockRejected = true }
      if placement.resynced { tile.audioResyncs &+= 1 }
      if let drift = placement.drift { tile.lastAudioDrift = drift }
    }
  }

  /// Drains queued audio, giving an unready writer a bounded chance to start accepting again.
  private func drainAudio(waitingUpTo seconds: Double) async {
    let deadline = Date().addingTimeInterval(seconds)
    while true {
      drainAudio(limit: .max)
      if pendingAudioCount() == 0 || Date() >= deadline { return }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
  }

  // The lock cannot be taken directly inside an async function.
  private func pendingAudioCount() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return pendingAudio.count
  }

  /// Hands queued audio to the writer, at most `limit` buffers per call.
  ///
  /// Also called after every video append, so an input that was briefly unready gets flushed by the
  /// ongoing video flow rather than waiting for the next audio buffer. Both the serialisation and
  /// the limit are there because this can run on a frame-delivery thread, where an unbounded drain
  /// stalls video — see `ProgramEncoder.drainAudio` for what that looked like in practice.
  private func drainAudio(limit: Int) {
    lock.lock()
    if isDraining {
      lock.unlock()
      return
    }
    isDraining = true
    lock.unlock()

    defer {
      lock.lock()
      isDraining = false
      lock.unlock()
    }

    var drained = 0
    var written: Double?
    defer {
      // One telemetry update per drain rather than one per buffer: this path is hot and every
      // update takes another lock.
      if let written {
        telemetry.mutateTile(sourceIndex) { $0.archiveAudioSeconds = written }
      }
    }

    while drained < limit {
      lock.lock()
      guard
        !finishing,
        let audioInput,
        audioInput.isReadyForMoreMediaData,
        !pendingAudio.isEmpty
      else {
        let starved = !finishing && !pendingAudio.isEmpty && self.audioInput != nil
        lock.unlock()
        if starved { telemetry.mutateTile(sourceIndex) { $0.audioDrainNotReady &+= 1 } }
        return
      }
      let buffer = pendingAudio.removeFirst()
      lock.unlock()

      // The result was discarded here. A refused append loses the buffer while `written` still
      // advances, so the telemetry reported audio that never reached the file.
      if audioInput.append(buffer) {
        telemetry.mutateTile(sourceIndex) { $0.audioAppended &+= 1 }
        written = CMTimeAdd(
          buffer.presentationTimeStamp,
          CMSampleBufferGetDuration(buffer)
        ).seconds
      } else {
        telemetry.mutateTile(sourceIndex) { $0.audioAppendFailed &+= 1 }
      }
      drained += 1
    }
  }
}
