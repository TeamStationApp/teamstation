import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ProducerCore
import ProducerSources
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
    config: AppConfig
  ) {
    self.telemetry = telemetry
    self.converter = converter
    self.width = config.programResolution.width
    self.height = config.programResolution.height
    self.bitrate = config.programBitrate
    self.frameRate = config.programFrameRate
    self.gopSeconds = config.gopSeconds
    self.codec = config.programCodec
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
    lock.unlock()

    try FileManager.default.createDirectory(at: ProducerPaths.program, withIntermediateDirectories: true)
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let url = ProducerPaths.program
      .appendingPathComponent("program-\(formatter.string(from: wall.date)).mp4")
    try? FileManager.default.removeItem(at: url)

    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
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
    self.baseAudioTime = nil
    self.nextAudioTime = nil
    self.lastTime = .negativeInfinity
    self.writtenFrames = 0
    self.isRunning = true
    self.outputURL = url
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
      return
    }
    if baseTime == nil {
      baseTime = presentationTime
      writer.startSession(atSourceTime: .zero)
    }
    guard let base = baseTime else {
      lock.unlock()
      return
    }
    var time = CMTimeSubtract(presentationTime, base)
    if time <= lastTime {
      time = CMTimeAdd(lastTime, CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1))))
    }
    lastTime = time
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

  public func finish() async -> URL? {
    // Before the writer is taken away, or the tail of the audio track is discarded. Waiting matters
    // here: a writer that is not accepting audio at this instant usually is a moment later, and
    // giving up on the first refusal truncates the track. See `SegmentWriter.finish`.
    let deadline = Date().addingTimeInterval(2)
    while true {
      drainAudio(limit: .max)
      if pendingAudioCount() == 0 || Date() >= deadline { break }
      try? await Task.sleep(nanoseconds: 20_000_000)
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
