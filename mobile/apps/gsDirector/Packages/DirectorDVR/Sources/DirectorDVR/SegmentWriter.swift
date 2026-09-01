import AVFoundation
import CoreMedia
import Darwin
import Foundation
import VideoToolbox
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

/// One camera's archive: the bytes it sent, muxed into segmented fMP4, with black and silence
/// holding the recording wall clock when the camera is missing or changes format.
///
/// Live pictures are still a bitstream copy — there is no second encode of the camera while it
/// is healthy. A small filler encoder writes black (and silent AAC) into holes, and transcodes
/// a size change down to the size locked on the first keyframe of the take. Stretching one
/// sample across a 50 s hole is refused (`maximumFrameDuration`); the hole is many legal frames
/// instead.
///
/// Two AVFoundation constraints shape the implementation, both established by measurement rather
/// than documentation:
///
/// - Passthrough of a video *and* an audio track is refused outright when
///   `preferredOutputSegmentInterval` is a positive time (`-11875`). Custom segmentation —
///   `.indefinite` plus `flushSegment()` before a sync sample — accepts both, so that is how
///   segments are cut, on the camera's own keyframes.
/// - In fragmented MP4 the per-sample durations *are* the timeline, and a sample with no duration
///   is refused (`-16364`). Sample timestamps follow recording wall clock, not the camera's RTP
///   clock, so a reboot that resets PTS still lands at `now - T0`.
public final class SegmentWriter: NSObject, ArchiveSink, @unchecked Sendable {
  /// Called when the camera's format changed under an open recording, which needs a fresh writer.
  public typealias FormatChangeHandler = @Sendable (SourceID) -> Void

  /// Roughly two seconds of audio at the buffer sizes cameras send.
  private static let maximumPendingAudio = 200
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
  /// Recording wall origin. Late cameras fill black from this instant so every file lasts `D`.
  private let recordingStartedAt: WallClock?
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
  private var filler: ArchiveFiller?
  private var lockedWidth = 0
  private var lockedHeight = 0
  private var fileOriginWall: WallClock?
  private var holdTimer: DispatchSourceTimer?
  private var fillerFrameID: UInt64 = 1_000_000_000

  private struct HeldPicture {
    let data: Data
    let presentationTime: CMTime
    let wallClock: WallClock
    let isKeyframe: Bool
    let frameID: UInt64
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
    recordingStartedAt: WallClock? = nil,
    onFormatChange: FormatChangeHandler? = nil
  ) {
    self.sourceID = sourceID
    self.sourceIndex = sourceIndex
    self.recordingID = recordingID
    self.index = index
    self.telemetry = telemetry
    self.settings = settings
    self.clock = clock
    self.recordingStartedAt = recordingStartedAt
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

  public func finish(until wall: WallClock? = nil) async {
    // The held picture is a real frame of the recording; without this the last one is lost every
    // time, and with a one-second keyframe interval that is visible at the cut.
    let end = wall ?? clock.now
    await onQueue {
      self.fillOnQueue(to: end)
      self.flushHeld()
      self.stopHoldTimer()
    }

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
    fileOriginWall = nil
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

    guard let format = CompressedSample.videoFormatDescription(
      codec: frame.codec,
      parameterSets: frame.parameterSets
    ) else {
      lock.unlock()
      return
    }
    let incoming = ArchiveFiller.dimensions(of: format)
    let hadLock = lockedWidth > 0
    if !hadLock {
      if !frame.isKeyframe {
        lock.unlock()
        return
      }
      lockedWidth = incoming.width
      lockedHeight = incoming.height
      filler = ArchiveFiller(
        width: incoming.width,
        height: incoming.height,
        codec: frame.codec == .hevc ? .hevc : .h264
      )
      videoParameterSets = frame.parameterSets
      videoFormat = format
    }
    lock.unlock()

    fillOnQueue(to: frame.wallClock)

    var coded = frame
    var codedFormat = format
    if hadLock, (incoming.width != lockedWidth || incoming.height != lockedHeight) {
      lock.lock()
      let filler = self.filler
      let origin = fileOrigin()
      lock.unlock()
      let pts = mediaTime(for: frame.wallClock, origin: origin)
      if let transcoded = filler?.transcode(frame, presentationTime: pts),
        let lockedFormat = CompressedSample.videoFormatDescription(
          codec: transcoded.codec,
          parameterSets: transcoded.parameterSets
        )
      {
        coded = transcoded
        codedFormat = lockedFormat
      } else if let black = filler?.encodeBlack(
        sourceID: sourceID,
        presentationTime: pts,
        wallClock: frame.wallClock,
        frameID: frame.frameID
      ) {
        coded = black
        if let lockedFormat = CompressedSample.videoFormatDescription(
          codec: black.codec,
          parameterSets: black.parameterSets
        ) {
          codedFormat = lockedFormat
        }
      } else {
        return
      }
    } else if !hadLock {
      lock.lock()
      videoFormat = codedFormat
      videoParameterSets = coded.parameterSets
      lock.unlock()
    }

    lock.lock()
    videoFormat = videoFormat ?? codedFormat
    lock.unlock()
    let duration = filler?.frameDuration ?? CMTime(value: 1, timescale: 30)
    appendVideo(
      HeldPicture(
        data: coded.data,
        presentationTime: coded.presentationTime,
        wallClock: coded.wallClock,
        isKeyframe: coded.isKeyframe,
        frameID: coded.frameID
      ),
      duration: duration
    )
  }

  /// Writes out the picture still being held, at the last known frame duration since there is no
  /// successor to measure against.
  private func flushHeld() {
    lock.lock()
    let previous = held
    held = nil
    let duration = lastVideoDuration
    lock.unlock()
    guard let previous else { return }
    appendVideo(previous, duration: duration)
  }

  private func appendVideo(_ picture: HeldPicture, duration: CMTime, filling: Bool = true) {
    lock.lock()
    guard !finishing, stopError == nil, let format = videoFormat else {
      lock.unlock()
      return
    }

    if !started {
      lock.unlock()
      ensureAudioFormat()
      guard startWriting(videoFormat: format) else { return }
      startHoldTimer()
      lock.lock()
    }
    if filling {
      lock.unlock()
      fillOnQueue(to: picture.wallClock)
      lock.lock()
      guard !finishing, stopError == nil, videoFormat != nil else {
        lock.unlock()
        return
      }
    }
    guard let writer, let videoInput else {
      lock.unlock()
      return
    }

    if fileOriginWall == nil {
      fileOriginWall = recordingStartedAt ?? picture.wallClock
    }
    if baseWallClock == nil {
      baseWallClock = fileOriginWall
      basePresentationTime = .zero
    }
    guard let origin = fileOriginWall else {
      lock.unlock()
      return
    }

    let presentationTime = mediaTime(for: picture.wallClock, origin: origin)
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

    var sampleDuration = duration
    if !sampleDuration.isNumeric || sampleDuration <= .zero
      || sampleDuration.seconds > Self.maximumFrameDuration {
      sampleDuration = lastVideoDuration
    }
    lastVideoDuration = sampleDuration
    lastVideoTime = presentationTime
    if pendingFirstFrameID == nil { pendingFirstFrameID = picture.frameID }

    // Segments are cut at the camera's keyframes, which is the only place a segment can start.
    let shouldFlush = picture.isKeyframe
      && boundary.shouldFlush(at: presentationTime.seconds, isKeyframe: true)
    let isReady = videoInput.isReadyForMoreMediaData
    lock.unlock()

    if shouldFlush {
      // Audio first, so the file being closed carries the sound that belongs to it.
      drainAudio(limit: .max)
      recycleWriter()
      // This keyframe opens the next file so the cut stays on a sync sample.
      appendVideo(picture, duration: duration, filling: false)
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

  public func fill(to wall: WallClock) {
    queue.async { [weak self] in self?.fillOnQueue(to: wall) }
  }

  public func fillAndWait(to wall: WallClock) async {
    await onQueue { self.fillOnQueue(to: wall) }
  }

  private func fileOrigin() -> WallClock {
    if let fileOriginWall { return fileOriginWall }
    let origin = recordingStartedAt ?? clock.now
    fileOriginWall = origin
    if baseWallClock == nil { baseWallClock = origin }
    return origin
  }

  private func mediaTime(for wall: WallClock, origin: WallClock) -> CMTime {
    CMTime(seconds: max(0, wall - origin), preferredTimescale: 90_000)
  }

  private func ensureAudioFormat() {
    lock.lock()
    defer { lock.unlock() }
    guard settings.includesAudio, audioFormat == nil, let filler else { return }
    audioFormat = CompressedSample.aacFormatDescription(
      magicCookie: filler.magicCookie,
      sampleRate: filler.audioSampleRate,
      channelCount: filler.audioChannels
    )
  }

  private func startHoldTimer() {
    lock.lock()
    guard holdTimer == nil else {
      lock.unlock()
      return
    }
    lock.unlock()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      self.fillOnQueue(to: self.clock.now)
    }
    timer.resume()
    lock.lock()
    holdTimer = timer
    lock.unlock()
  }

  private func stopHoldTimer() {
    lock.lock()
    holdTimer?.cancel()
    holdTimer = nil
    lock.unlock()
  }

  private func fillOnQueue(to wall: WallClock) {
    lock.lock()
    guard !finishing, stopError == nil, filler != nil else {
      lock.unlock()
      return
    }
    let origin = fileOrigin()
    let step = filler?.frameDuration ?? CMTime(value: 1, timescale: 30)
    let frameRate = filler?.frameRate ?? 30
    lock.unlock()

    let target = mediaTime(for: wall, origin: origin)
    lock.lock()
    let last = lastVideoTime
    lock.unlock()
    let lastSeconds = last.isNumeric ? last.seconds : 0
    let cappedSeconds = min(target.seconds, lastSeconds + 120)
    let capped = CMTime(seconds: max(0, cappedSeconds), preferredTimescale: 90_000)
    var frames = 0
    let maximumFrames = Int((120 * Double(max(frameRate, 1))).rounded(.up)) + 2
    while frames < maximumFrames {
      lock.lock()
      let cursorTime = lastVideoTime
      lock.unlock()
      let cursor = cursorTime.isNumeric ? cursorTime : CMTime(value: -step.value, timescale: step.timescale)
      let next = CMTimeAdd(cursor, step)
      guard next.isNumeric, next.seconds + 0.001 < capped.seconds else { break }
      let sampleWall = origin + next.seconds
      appendFiller(at: next, wall: sampleWall)
      lock.lock()
      let advanced = lastVideoTime
      lock.unlock()
      // A failed encode must not spin: lastVideoTime would stay put and this loop would never end.
      guard advanced.isNumeric, advanced.seconds + 0.0001 >= next.seconds else { break }
      frames += 1
    }
  }

  private func appendFiller(at presentationTime: CMTime, wall: WallClock) {
    lock.lock()
    let filler = self.filler
    fillerFrameID &+= 1
    let frameID = fillerFrameID
    lock.unlock()
    guard let filler else { return }
    guard
      let coded = filler.encodeBlack(
        sourceID: sourceID,
        presentationTime: presentationTime,
        wallClock: wall,
        frameID: frameID
      )
    else { return }
    appendVideo(
      HeldPicture(
        data: coded.data,
        presentationTime: presentationTime,
        wallClock: wall,
        isKeyframe: true,
        frameID: frameID
      ),
      duration: filler.frameDuration,
      filling: false
    )
    if settings.includesAudio,
      let silence = filler.encodeSilence(
        sourceID: sourceID,
        presentationTime: presentationTime,
        wallClock: wall
      )
    {
      appendSilence(silence, at: presentationTime)
    }
  }

  private func appendSilence(_ frame: CompressedAudioFrame, at time: CMTime) {
    ensureAudioFormat()
    lock.lock()
    let format = audioFormat
    lock.unlock()
    guard settings.includesAudio, let format else { return }
    guard
      let sampleBuffer = CompressedSample.audioSampleBuffer(
        data: frame.data,
        formatDescription: format,
        presentationTime: time,
        duration: frame.duration
      )
    else { return }
    lock.lock()
    pendingAudio.append(sampleBuffer)
    if pendingAudio.count > Self.maximumPendingAudio {
      pendingAudio.removeFirst(pendingAudio.count - Self.maximumPendingAudio)
    }
    lock.unlock()
    drainAudio(limit: 8)
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
    let nextOrigin = startWall.map { $0 + max(0, duration) }
    self.writer = nil
    self.videoInput = nil
    self.audioInput = nil
    self.outputFilename = nil
    started = false
    basePresentationTime = nil
    // Each file is 0-based for concat. The next file's origin is this file's end wall, not
    // recording T0, or fill would write the whole take into every later segment.
    baseWallClock = nextOrigin
    fileOriginWall = nextOrigin
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
    lock.lock()
    guard !finishing, settings.includesAudio, stopError == nil else {
      lock.unlock()
      return
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
      return
    }

    let placement = audioTimeline.place(
      sourceTime: frame.presentationTime,
      duration: frame.duration,
      videoTime: lastVideoTime
    )
    lock.unlock()

    guard let placement, placement.start.isNumeric, placement.start >= .zero else { return }
    report(placement)

    guard let sampleBuffer = CompressedSample.audioSampleBuffer(
      data: frame.data,
      formatDescription: format,
      presentationTime: placement.start,
      duration: frame.duration
    ) else { return }

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
        lock.unlock()
        return
      }
      let buffer = pendingAudio.removeFirst()
      lock.unlock()

      audioInput.append(buffer)
      written = CMTimeAdd(
        buffer.presentationTimeStamp,
        CMSampleBufferGetDuration(buffer)
      ).seconds
      drained += 1
    }
  }
}
