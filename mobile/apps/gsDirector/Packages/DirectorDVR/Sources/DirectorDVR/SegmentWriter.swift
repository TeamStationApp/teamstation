import AVFoundation
import CoreMedia
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
  private static let maximumPendingAudio = 200
  /// A gap longer than this is a clock glitch rather than lost frames, and giving one sample a
  /// duration that long would stretch the whole timeline.
  private static let maximumFrameDuration: Double = 2

  public let sourceID: SourceID
  public let tileIndex: Int
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
  private var pendingFirstFrameID: UInt64?
  private var droppedFrames: UInt64 = 0
  private var appendedFrames: UInt64 = 0
  private var stopError: Error?

  private struct HeldPicture {
    let data: Data
    let presentationTime: CMTime
    let isKeyframe: Bool
    let frameID: UInt64
  }

  public init(
    sourceID: SourceID,
    tileIndex: Int,
    recordingID: Int64,
    index: ArchiveIndex,
    telemetry: PipelineTelemetry,
    settings: SegmentWriterSettings,
    clock: DirectorClock,
    directory: URL? = nil,
    onFormatChange: FormatChangeHandler? = nil
  ) {
    self.sourceID = sourceID
    self.tileIndex = tileIndex
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

    telemetry.mutateTile(tileIndex) { $0.isArchiving = true }
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
    telemetry.mutateTile(tileIndex) {
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
      hasSession: started
    )
  }

  private func clearWriter() {
    lock.lock()
    defer { lock.unlock() }
    writer = nil
    videoInput = nil
    audioInput = nil
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
      telemetry.mutateTile(tileIndex) { $0.lastError = detail }
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
    held = HeldPicture(
      data: frame.data,
      presentationTime: frame.presentationTime,
      isKeyframe: frame.isKeyframe,
      frameID: frame.frameID
    )
    guard let previous else {
      lock.unlock()
      return
    }
    let gap = CMTimeSubtract(frame.presentationTime, previous.presentationTime)
    lock.unlock()

    appendVideo(previous, duration: gap)
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

  private func appendVideo(_ picture: HeldPicture, duration: CMTime) {
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
      baseWallClock = clock.now
    }
    guard let base = basePresentationTime else {
      lock.unlock()
      return
    }

    let presentationTime = CMTimeSubtract(picture.presentationTime, base)
    guard presentationTime.isNumeric, presentationTime >= .zero else {
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: tileIndex)
      return
    }
    // A timestamp that does not advance means the camera's clock reset. Passing it on would fail
    // the writer for the rest of the recording, so the frame is dropped instead.
    if started, presentationTime <= lastVideoTime {
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: tileIndex)
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
      // Audio first, so the segment being closed carries the sound that belongs to it.
      drainAudio(limit: .max)
      writer.flushSegment()
    }

    guard isReady else {
      lock.lock()
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: tileIndex)
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
      telemetry.recordDroppedFrame(tile: tileIndex)
      return
    }

    if videoInput.append(sampleBuffer) {
      lock.lock()
      appendedFrames &+= 1
      lock.unlock()
      let seconds = presentationTime.seconds
      telemetry.mutateTile(tileIndex) { $0.archiveVideoSeconds = seconds }
      telemetry.recordArchivedFrame(tile: tileIndex)
    } else {
      lock.lock()
      droppedFrames &+= 1
      lock.unlock()
      telemetry.recordDroppedFrame(tile: tileIndex)
    }

    // Small budget: audio's own arrival does the bulk, and this runs between video appends.
    drainAudio(limit: 2)
  }

  /// Builds the writer around the camera's formats. Called once, at the first keyframe.
  private func startWriting(videoFormat format: CMVideoFormatDescription) -> Bool {
    lock.lock()
    let audioFormat = self.audioFormat
    lock.unlock()

    let writer = AVAssetWriter(contentType: UTType.mpeg4Movie)
    writer.outputFileTypeProfile = .mpeg4AppleHLS
    // Custom segmentation. A positive interval would refuse the audio track outright in
    // passthrough, and the camera's keyframes are better boundaries than a clock anyway.
    writer.preferredOutputSegmentInterval = .indefinite
    writer.shouldOptimizeForNetworkUse = false
    writer.delegate = self

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
    started = true
    lock.unlock()

    telemetry.mutateTile(tileIndex) {
      $0.isArchiving = true
      $0.archiveHeight = Int(dimensions.height)
    }
    return true
  }

  private func recordStartFailure(_ error: SegmentWriterError) {
    lock.lock()
    stopError = error
    lock.unlock()
    telemetry.recordError("archive \(sourceID.rawValue) failed: \(error.description)")
    telemetry.mutateTile(tileIndex) { $0.lastError = error.description }
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
      telemetry.mutateTile(tileIndex) { $0.audioBuffersDiscarded &+= 1 }
    }
    lock.unlock()

    drainAudio(limit: 8)
  }

  private func report(_ placement: ArchiveAudioTimeline.Placement) {
    guard placement.rejectedClock || placement.resynced || placement.drift != nil else { return }
    telemetry.mutateTile(tileIndex) { tile in
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
        telemetry.mutateTile(tileIndex) { $0.archiveAudioSeconds = written }
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

// MARK: - AVAssetWriterDelegate

extension SegmentWriter: AVAssetWriterDelegate {
  public func assetWriter(
    _ writer: AVAssetWriter,
    didOutputSegmentData segmentData: Data,
    segmentType: AVAssetSegmentType,
    segmentReport: AVAssetSegmentReport?
  ) {
    let free = DirectorPaths.freeDiskBytes()
    if free < settings.minimumFreeDiskBytes {
      lock.lock()
      stopError = SegmentWriterError.diskFull(free)
      lock.unlock()
      telemetry.recordError("disk headroom exhausted — archiving stopped for \(sourceID)")
      return
    }

    lock.lock()
    let sequenceNumber = sequence
    sequence += 1
    let firstFrameID = pendingFirstFrameID
    pendingFirstFrameID = nil
    let base = baseWallClock
    lock.unlock()

    let isInitialization = segmentType == .initialization
    // Sequence is in the filename so a writer reopened mid-recording cannot overwrite the previous
    // one's init.mp4 / seg-00001.mp4.
    let filename = isInitialization
      ? String(format: "init-%05d.mp4", sequenceNumber)
      : String(format: "seg-%05d.mp4", sequenceNumber)
    let url = directory.appendingPathComponent(filename)

    do {
      try segmentData.write(to: url, options: .atomic)
    } catch {
      telemetry.recordError("failed to write \(filename): \(error.localizedDescription)")
      return
    }

    let videoReport = segmentReport?.trackReports.first { $0.mediaType == .video }
    let earliest = videoReport?.earliestPresentationTimeStamp ?? .zero
    let duration = videoReport?.duration ?? .zero
    let startWall = (base ?? clock.now) + (earliest.isNumeric ? earliest.seconds : 0)

    do {
      try index.insertSegment(
        recordingID: recordingID,
        sourceID: sourceID,
        sequence: sequenceNumber,
        filename: "rec-\(recordingID)/\(filename)",
        isInitialization: isInitialization,
        startWall: startWall,
        duration: duration.isNumeric ? duration.seconds : 0,
        byteCount: Int64(segmentData.count),
        firstFrameID: firstFrameID
      )
      if !isInitialization {
        telemetry.recordSegment(bytes: UInt64(segmentData.count))
      }
    } catch {
      telemetry.recordError("index write failed for \(filename): \(error)")
    }
  }
}
