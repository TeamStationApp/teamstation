import AVFoundation
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import DirectorCore
import DirectorSources
import VideoToolbox

/// The single program encode session, writing the master output file.
///
/// v1 egress is a file (plan §9). The repo's existing `src/server/rtmp/splitter.ts` is the
/// natural target later; nothing here would need to change except where the encoded samples go.
public final class ProgramEncoder: @unchecked Sendable {
  public private(set) var outputURL: URL?

  private let telemetry: PipelineTelemetry
  private let converter: PixelConverter
  private let width: Int
  private let height: Int
  private let bitrate: Int
  private let frameRate: Int
  private let gopSeconds: Double
  private let codec: ProgramCodec
  private let directory: URL

  private let lock = NSLock()
  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var baseTime: CMTime?
  private var lastTime: CMTime = .negativeInfinity
  /// Audio needs its own base: a source's audio and video timestamps need not share a timebase.
  /// See `SegmentWriter` — a camera's audio and video clocks run independently.
  private var baseAudioTime: CMTime?
  /// End of the last audio sample written; every candidate start is clamped forward to it.
  private var nextAudioTime: CMTime?
  /// The source's audio clock mapped onto the program timeline by one offset, so real pacing and
  /// upstream gaps survive. See `SegmentWriter` for why counting samples is only the fallback.
  private var audioSourceEpoch: CMTime?
  private var audioTimelineAnchor: CMTime?
  private var audioClockUnusable = false
  /// Audio awaiting a writer that is not currently accepting it. Discarding instead of queueing
  /// leaves the audio track short of the video track, which stalls the muxer outright.
  private var pendingAudio: [CMSampleBuffer] = []
  /// Only one thread drains at a time. `AVAssetWriterInput.append` from two threads at once is not
  /// safe, and several threads reach the drain here.
  private var isDraining = false
  private var writtenFrames: UInt64 = 0
  private var part = 1
  public private(set) var outputURLs: [URL] = []
  /// Incoming compositor time of the last successful video sample, kept across a writer recover
  /// so the continuation file can hold the dead interval as black + silence.
  private var lastSourceTime: CMTime?
  private var pendingRecoveryFill = false
  /// Host time of the first sample of this part, so the bound below is cumulative rather than
  /// per-frame. Instant replay delivers on the host clock while live delivers on the compositor
  /// timebase; a single such sample wrote a jump of days into the programme file, and export
  /// then scored the file unplayable and refused the whole recording with "no files to remux".
  private var partStartHost: Double?
  /// How far past real time the programme clock may run before a sample is treated as carrying a
  /// foreign timestamp. Loose enough to absorb scheduling jitter and a late frame burst.
  private static let timelineAdvanceSlack: Double = 2
  private var sessionStarted = false
  private var blackPixelBuffer: CVPixelBuffer?
  /// Wall clock of `start(at:)`, used to fill the program file out to recording end when the
  /// compositor never delivered a frame (otherwise `finishWriting` hangs on an unstarted session).
  private var startedAt: WallClock?

  /// Roughly two seconds of audio at the buffer sizes cameras send.
  private static let maximumPendingAudio = 200

  /// A buffer's duration, derived from its sample count when the source did not set one.
  private static func audioDuration(of buffer: CMSampleBuffer) -> CMTime {
    let stated = CMSampleBufferGetDuration(buffer)
    if stated.isNumeric, stated > .zero { return stated }
    let samples = CMSampleBufferGetNumSamples(buffer)
    guard samples > 0 else { return .invalid }
    let rate = CMSampleBufferGetFormatDescription(buffer)
      .flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mSampleRate }
      ?? 48_000
    guard rate > 0 else { return .invalid }
    return CMTime(value: CMTimeValue(samples), timescale: CMTimeScale(rate))
  }
  private var isRunning = false

  public init(
    telemetry: PipelineTelemetry,
    converter: PixelConverter,
    config: AppConfig,
    directory: URL = DirectorPaths.program
  ) {
    self.telemetry = telemetry
    self.converter = converter
    self.width = config.programResolution.width
    self.height = config.programResolution.height
    self.bitrate = config.programBitrate
    self.frameRate = config.programFrameRate
    self.gopSeconds = config.gopSeconds
    self.codec = config.programCodec
    self.directory = directory
  }

  public var frameCount: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return writtenFrames
  }

  public var running: Bool {
    lock.lock()
    defer { lock.unlock() }
    return isRunning
  }

  public func start(at wall: WallClock) throws {
    lock.lock()
    guard !isRunning else {
      lock.unlock()
      return
    }
    let continuing = pendingRecoveryFill
    if !continuing {
      part = 1
      outputURLs = []
      lastSourceTime = nil
      pendingRecoveryFill = false
      startedAt = wall
    }
    sessionStarted = false
    lock.unlock()

    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let suffix = part == 1 ? "" : "-\(part)"
    let url = directory.appendingPathComponent(
      "program-\(formatter.string(from: wall.date))\(suffix).mp4"
    )
    try? FileManager.default.removeItem(at: url)

    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    writer.movieFragmentInterval = CMTime(seconds: 3, preferredTimescale: 600)
    var compression: [String: Any] = [
      AVVideoAverageBitRateKey: bitrate,
      AVVideoMaxKeyFrameIntervalDurationKey: gopSeconds,
      AVVideoExpectedSourceFrameRateKey: frameRate,
      AVVideoAllowFrameReorderingKey: false
    ]
    compression[AVVideoProfileLevelKey] = codec == .hevc
      ? kVTProfileLevel_HEVC_Main_AutoLevel as String
      : AVVideoProfileLevelH264HighAutoLevel

    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: compression
    ])
    videoInput.expectsMediaDataInRealTime = true
    guard writer.canAdd(videoInput) else {
      throw ProgramEncoderError.writerRejectedInput
    }
    writer.add(videoInput)

    // Stereo, matching the mix bus. A mono track here would have the writer fold the mix down on
    // the way in, throwing away any stereo the cameras contributed.
    let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: AudioMixer.sampleRate,
      AVNumberOfChannelsKey: AudioMixer.channelCount,
      AVEncoderBitRateKey: 192_000
    ])
    audioInput.expectsMediaDataInRealTime = true
    if writer.canAdd(audioInput) { writer.add(audioInput) }

    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: videoInput,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height
      ]
    )

    guard writer.startWriting() else {
      throw ProgramEncoderError.startFailed(Self.describe(writer.error))
    }

    lock.lock()
    self.writer = writer
    self.videoInput = videoInput
    self.audioInput = audioInput
    self.adaptor = adaptor
    self.baseTime = nil
    self.partStartHost = nil
    self.baseAudioTime = nil
    self.nextAudioTime = nil
    self.lastTime = .negativeInfinity
    self.writtenFrames = 0
    self.audioSourceEpoch = nil
    self.audioTimelineAnchor = nil
    self.audioClockUnusable = false
    self.pendingAudio.removeAll()
    self.isRunning = true
    self.outputURL = url
    self.outputURLs.append(url)
    lock.unlock()

    telemetry.recordEncodeSessionChange(delta: 1)
  }

  /// `pixelBuffer` may be BGRA straight out of the compositor; it is converted once here.
  public func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
    lock.lock()
    guard isRunning, let writer, let adaptor, let videoInput else {
      lock.unlock()
      return
    }
    if writer.status == .failed {
      lock.unlock()
      telemetry.recordError("program writer failed: \(Self.describe(writer.error))")
      recoverAfterFailure()
      return
    }
    if pendingRecoveryFill {
      pendingRecoveryFill = false
      let gap = lastSourceTime.map { max(0, CMTimeSubtract(presentationTime, $0).seconds) } ?? 0
      lock.unlock()
      fillHold(seconds: gap)
      lock.lock()
      guard isRunning, writer.status != .failed else {
        lock.unlock()
        return
      }
      if lastTime.isNumeric, lastTime >= .zero {
        let next = CMTimeAdd(lastTime, CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1))))
        baseTime = CMTimeSubtract(presentationTime, next)
      }
    }
    if baseTime == nil {
      baseTime = presentationTime
      if !sessionStarted {
        writer.startSession(atSourceTime: .zero)
        sessionStarted = true
      }
    }
    guard let base = baseTime else {
      lock.unlock()
      return
    }
    var time = CMTimeSubtract(presentationTime, base)
    let oneFrame = CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1)))
    // The programme clock may not outrun real time. A stalled compositor spends wall clock too,
    // so a genuine gap still holds and the file keeps recording wall clock; a sample arriving on
    // another source's timebase does not, and is re-based onto the next frame.
    let nowHost = CFAbsoluteTimeGetCurrent()
    if partStartHost == nil { partStartHost = nowHost }
    if let partStart = partStartHost, lastTime.isNumeric, lastTime >= .zero {
      let realElapsed = max(0, nowHost - partStart)
      if !time.isNumeric || time.seconds < -0.5
        || time.seconds > realElapsed + Self.timelineAdvanceSlack {
        time = CMTimeAdd(lastTime, oneFrame)
        baseTime = CMTimeSubtract(presentationTime, time)
      }
    }
    if time <= lastTime {
      time = CMTimeAdd(lastTime, oneFrame)
    }
    lastTime = time
    lastSourceTime = presentationTime
    let ready = videoInput.isReadyForMoreMediaData
    lock.unlock()

    guard ready else { return }

    // Matching the pixel format is not enough: the program file has a fixed size, and appending
    // a buffer of any other size fails the writer outright rather than scaling it. A camera on
    // its proxy stream is 640x360 while the program is 1080p, so this is the normal case.
    let isEncodable = CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      && CVPixelBufferGetWidth(pixelBuffer) == width
      && CVPixelBufferGetHeight(pixelBuffer) == height
    let encodable = isEncodable
      ? pixelBuffer
      : converter.convert(pixelBuffer: pixelBuffer, width: width, height: height)
    guard let encodable else { return }

    if adaptor.append(encodable, withPresentationTime: time) {
      lock.lock()
      writtenFrames += 1
      lock.unlock()
    }

    // A small budget: this runs on a tile's frame-delivery thread, and audio has its own callback
    // to do the bulk of the work. This is only here so a briefly unready input still gets flushed.
    drainAudio(limit: 2)
  }

  public func append(audio frame: AudioFrame) {
    let duration = Self.audioDuration(of: frame.sampleBuffer)

    lock.lock()
    guard isRunning, audioInput != nil, baseTime != nil else {
      lock.unlock()
      return
    }
    guard lastTime.isNumeric, duration.isNumeric, duration > .zero else {
      lock.unlock()
      return
    }
    let start = audioStartLocked(sourceTime: frame.sampleBuffer.presentationTimeStamp)
    nextAudioTime = CMTimeAdd(start, duration)
    lock.unlock()

    let shifted = start
    guard shifted.isNumeric, shifted >= .zero else { return }
    var timing = CMSampleTimingInfo(
      duration: duration,
      presentationTimeStamp: shifted,
      decodeTimeStamp: .invalid
    )
    var retimed: CMSampleBuffer?
    guard CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: frame.sampleBuffer,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &retimed
    ) == noErr, let retimed else { return }

    lock.lock()
    pendingAudio.append(retimed)
    if pendingAudio.count > Self.maximumPendingAudio {
      pendingAudio.removeFirst(pendingAudio.count - Self.maximumPendingAudio)
    }
    lock.unlock()

    drainAudio(limit: 8)
  }

  /// Where the next audio buffer belongs on the program timeline. Called with `lock` held.
  ///
  /// Mirrors `SegmentWriter.audioStartLocked`; see there for why each guard exists.
  private func audioStartLocked(sourceTime: CMTime) -> CMTime {
    var candidate: CMTime
    if !audioClockUnusable, sourceTime.isNumeric {
      if audioSourceEpoch == nil {
        audioSourceEpoch = sourceTime
        audioTimelineAnchor = lastTime
      }
      let epoch = audioSourceEpoch ?? sourceTime
      let anchor = audioTimelineAnchor ?? lastTime
      candidate = CMTimeAdd(anchor, CMTimeSubtract(sourceTime, epoch))
    } else {
      candidate = nextAudioTime ?? lastTime
    }

    let offset = CMTimeSubtract(candidate, lastTime).seconds
    if !candidate.isNumeric || abs(offset) > 2 {
      audioClockUnusable = true
      candidate = nextAudioTime ?? lastTime
    }
    if CMTimeSubtract(lastTime, candidate).seconds > 0.5 { candidate = lastTime }
    if let next = nextAudioTime, candidate < next { candidate = next }
    return candidate
  }

  // The lock cannot be taken directly inside an async function.
  private func pendingAudioCount() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return pendingAudio.count
  }

  /// Hands queued audio to the writer, at most `limit` buffers per call.
  ///
  /// Both bounds matter, and the program encoder is where it shows. Its video arrives from the
  /// compositor while its audio arrives from every source's own capture thread, so several threads
  /// reach this at once — and `append` is called synchronously from each tile's frame-delivery
  /// thread, so a thread that sits here draining a long queue stalls that tile's video. Unbounded
  /// and unserialised, this produced quarter-second stutters and dropped frames by the hundred.
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
    while drained < limit {
      lock.lock()
      guard
        isRunning,
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
      drained += 1
    }
  }

  public func finish(until wall: WallClock? = nil) async -> URL? {
    // Before the writer is taken away, or the tail of the audio track is discarded. Waiting matters
    // here: a writer that is not accepting audio at this instant usually is a moment later, and
    // giving up on the first refusal truncates the track. See `SegmentWriter.finish`.
    let deadline = Date().addingTimeInterval(2)
    while true {
      drainAudio(limit: .max)
      if pendingAudioCount() == 0 || Date() >= deadline { break }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }

    if let wall, let origin = startedAt {
      fillHold(until: max(0, wall.seconds - origin.seconds))
    }

    guard let pending = takeWriterForFinish() else { return nil }

    pending.videoInput?.markAsFinished()
    pending.audioInput?.markAsFinished()
    // See SegmentWriter.finish(): `await writer.finishWriting()` picks the blocking overload.
    await withCheckedContinuation { continuation in
      pending.writer.finishWriting { continuation.resume() }
    }

    clearWriter()
    telemetry.recordEncodeSessionChange(delta: -1)
    return pending.url
  }

  // The lock is taken in these synchronous helpers because `NSLock.lock()` is unavailable
  // directly inside an async function.
  private struct PendingFinish {
    let writer: AVAssetWriter
    let videoInput: AVAssetWriterInput?
    let audioInput: AVAssetWriterInput?
    let url: URL?
  }

  private func takeWriterForFinish() -> PendingFinish? {
    lock.lock()
    defer { lock.unlock() }
    guard isRunning, let writer else { return nil }
    isRunning = false
    pendingRecoveryFill = false
    lastSourceTime = nil
    return PendingFinish(writer: writer, videoInput: videoInput, audioInput: audioInput, url: outputURL)
  }

  private func clearWriter() {
    lock.lock()
    defer { lock.unlock() }
    writer = nil
    videoInput = nil
    audioInput = nil
    adaptor = nil
    audioSourceEpoch = nil
    audioTimelineAnchor = nil
    audioClockUnusable = false
    pendingAudio.removeAll()
  }

  /// Opens a continuation file. The next video sample holds the dead interval as black + silence
  /// so concatenating parts does not skip wall clock. Tests call this to inject a writer death.
  public func recoverAfterFailure() {
    lock.lock()
    let failed = writer
    let hadSession = sessionStarted
    videoInput?.markAsFinished()
    audioInput?.markAsFinished()
    writer = nil
    videoInput = nil
    audioInput = nil
    adaptor = nil
    isRunning = false
    sessionStarted = false
    part += 1
    pendingRecoveryFill = true
    pendingAudio.removeAll()
    audioSourceEpoch = nil
    audioTimelineAnchor = nil
    audioClockUnusable = false
    nextAudioTime = nil
    lock.unlock()
    if let failed {
      if hadSession {
        let finished = DispatchSemaphore(value: 0)
        failed.finishWriting { finished.signal() }
        _ = finished.wait(timeout: .now() + 2)
      } else {
        failed.cancelWriting()
      }
    }
    telemetry.recordEncodeSessionChange(delta: -1)
    try? start(at: WallClock(date: Date()))
  }

  /// Black video and silent audio covering `seconds` at the start of the current file.
  private func fillHold(seconds: Double) {
    fillHold(until: seconds)
  }

  /// Black + silence from the last written program time (or zero) up to `end` seconds.
  ///
  /// 10 fps is enough for a hold: duration is the last PTS, and a 45s empty program must
  /// finish inside the stop-path deadline rather than encode hundreds of duplicate frames.
  private func fillHold(until end: Double) {
    let step = 0.1
    lock.lock()
    guard isRunning, let writer else {
      lock.unlock()
      return
    }
    if !sessionStarted {
      writer.startSession(atSourceTime: .zero)
      sessionStarted = true
    }
    if baseTime == nil { baseTime = .zero }
    let start = (lastTime.isNumeric && lastTime >= .zero) ? lastTime.seconds + step : 0
    lock.unlock()
    guard end - start > 0.0005 else { return }

    guard let black = programBlackBuffer() else { return }
    var cursor = start
    while cursor + 0.0005 < end {
      let time = CMTime(seconds: cursor, preferredTimescale: 600)
      appendHoldFrame(black, at: time)
      cursor += step
    }
    appendHoldSilence(until: CMTime(seconds: max(0, end), preferredTimescale: 600))
  }

  private func appendHoldFrame(_ pixelBuffer: CVPixelBuffer, at time: CMTime) {
    for _ in 0..<80 {
      lock.lock()
      let ready = isRunning && (videoInput?.isReadyForMoreMediaData ?? false)
      lock.unlock()
      if ready { break }
      usleep(5_000)
    }
    lock.lock()
    guard isRunning, let adaptor, let videoInput, videoInput.isReadyForMoreMediaData else {
      lock.unlock()
      return
    }
    lastTime = time
    lock.unlock()
    if adaptor.append(pixelBuffer, withPresentationTime: time) {
      lock.lock()
      writtenFrames += 1
      lock.unlock()
    }
  }

  private func appendHoldSilence(until end: CMTime) {
    guard end.isNumeric, end > .zero else { return }
    let frames = 1_024
    let channels = AudioMixer.channelCount
    let rate = AudioMixer.sampleRate
    let chunk = CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(rate))
    guard
      let format = AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(
          sampleRate: rate,
          channels: UInt32(channels)
        )
      )
    else { return }
    lock.lock()
    let existing = nextAudioTime
    lock.unlock()
    var cursor: CMTime = .zero
    if let existing, existing.isNumeric, existing > .zero {
      cursor = existing
    }
    guard cursor < end else { return }
    let zeros = [Int16](repeating: 0, count: frames * channels)
    while cursor < end {
      guard
        let buffer = AudioSampleBuilder.makeSampleBuffer(
          samples: zeros,
          formatDescription: format,
          presentationTime: cursor
        )
      else { break }
      lock.lock()
      pendingAudio.append(buffer)
      nextAudioTime = CMTimeAdd(cursor, chunk)
      lock.unlock()
      cursor = CMTimeAdd(cursor, chunk)
    }
    drainAudio(limit: .max)
  }

  private func programBlackBuffer() -> CVPixelBuffer? {
    if let blackPixelBuffer { return blackPixelBuffer }
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      [ kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any] ] as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    if let y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
      memset(y, 0, CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) * height)
    }
    if let uv = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
      memset(uv, 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * (height / 2))
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    blackPixelBuffer = buffer
    return buffer
  }

  /// AVFoundation's `localizedDescription` for a writer failure is often just "Cannot Encode",
  /// which names the symptom and nothing else. The code and the underlying error are what
  /// distinguish an unsupported setting from a resource that is temporarily unavailable.
  public static func describe(_ error: Error?) -> String {
    guard let error = error as NSError? else { return "unknown" }
    var parts = [ "\(error.localizedDescription) [\(error.domain) \(error.code)]" ]
    if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
      parts.append("underlying \(underlying.domain) \(underlying.code)")
    }
    if let reason = error.localizedFailureReason {
      parts.append(reason)
    }
    return parts.joined(separator: " — ")
  }

  public enum ProgramEncoderError: Error, CustomStringConvertible {
    case writerRejectedInput
    case startFailed(String)

    public var description: String {
      switch self {
      case .writerRejectedInput: "program writer rejected the video input"
      case let .startFailed(reason): "program writer failed to start: \(reason)"
      }
    }
  }
}
