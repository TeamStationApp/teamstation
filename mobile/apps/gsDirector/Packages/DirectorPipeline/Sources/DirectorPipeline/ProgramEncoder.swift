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

  private var anchorSink: AnchorSink?
  private var anchorRecordingID: Int64?
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
  /// Programme seconds of the last anchor written, so anchors land at a steady spacing rather
  /// than on every frame.
  private var lastAnchorSeconds: Double = -.infinity
  /// How far behind real time the on-air picture was when it was captured, from the last live
  /// frame that said. Carried across replays, whose frames have no capture time of their own.
  private var contentLagSeconds: Double?
  /// How often the programme records where it was in real time. Matches the movie-fragment
  /// interval, so an anchor lands about once per fragment without needing a fragment callback.
  private static let anchorIntervalSeconds: Double = 3
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
  /// Wall clock of the last frame actually placed on the programme timeline.
  ///
  /// The programme is watched afterwards, so its timeline has to be real time even across a
  /// stall. Without this, a frame arriving on a foreign timebase advanced the file by exactly one
  /// frame however long the compositor had been away, and the master ended shorter than the take
  /// it came from, accumulating at each
  /// stall and never recovering.
  private var lastAppendHost: Double?
  /// Host time at which this part's programme timeline reads zero. Set at the part's first frame,
  /// so a continuation after a recovery fill carries on from the held timeline.
  private var hostOrigin: Double?
  /// A source step longer than this is not frame spacing; one frame is assumed instead.
  private static let maximumSourceStep: Double = 0.25
  /// How far the timeline may stray from real time before it is put straight back.
  private static let hostReseatSeconds: Double = 0.25
  /// The fraction of the remaining error each frame takes back.
  private static let hostSteerGain: Double = 0.1
  /// Serialises recover so a failed writer noticed on video and audio at once does not
  /// open two continuation files.
  private var isRecovering = false
  /// Poison is finishing the live writer on the control thread; ingest must not append.
  private var poisonFinishing = false
  private var sessionStarted = false
  private var blackPixelBuffer: CVPixelBuffer?
  /// Wall clock of `start(at:)`, used to fill the program file out to recording end when the
  /// compositor never delivered a frame (otherwise `finishWriting` hangs on an unstarted session).
  private var startedAt: WallClock?
  /// Duration already committed to earlier continuation files, so `finish(until:)` fills
  /// the current part out to wall clock rather than writing a second full take.
  private var previousPartsDuration: Double = 0
  /// A resumed part whose first picture has not arrived yet. Its timeline begins with that picture,
  /// not at the resume, so the span before it is measured when it comes.
  private var resumedAwaitingPicture = false

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

  /// Called as the programme is written, with where it had reached and what time it was.
  ///
  /// A closure rather than an index reference so the encoder keeps knowing nothing about storage;
  /// the owner decides which recording the anchor belongs to.
  /// The recording is carried through rather than looked up, because this is called from whichever
  /// thread delivered the frame -- an NDI receive queue, an RTSP delivery queue -- and never the
  /// main actor. An earlier version read the owner's `activeRecordingID` through
  /// `MainActor.assumeIsolated`, which is a hard trap off the main actor and killed the app on the
  /// first frame after the record button.
  public typealias AnchorSink = @Sendable (
    _ recordingID: Int64,
    _ part: Int,
    _ programSeconds: Double,
    _ wall: WallClock
  ) -> Void

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

  /// Set once, after the owner has finished building itself. The encoder is constructed before the
  /// index it would write to exists, so this cannot be an initialiser argument.
  public func setAnchorSink(_ sink: AnchorSink?) {
    lock.lock()
    anchorSink = sink
    lock.unlock()
  }

  /// Which recording the anchors belong to, or nil when the programme is only being previewed.
  /// Set from the main actor as recording starts and stops; read under the encoder's own lock.
  public func setAnchorRecording(_ recordingID: Int64?) {
    lock.lock()
    anchorRecordingID = recordingID
    lock.unlock()
  }

  public func start(at wall: WallClock) throws {
    lock.lock()
    guard !isRunning else {
      lock.unlock()
      return
    }
    let continuing = pendingRecoveryFill
    resumedAwaitingPicture = false
    if !continuing {
      part = 1
      outputURLs = []
      lastSourceTime = nil
      lastAppendHost = nil
      lastAnchorSeconds = -.infinity
      contentLagSeconds = nil
      pendingRecoveryFill = false
      previousPartsDuration = 0
      startedAt = wall
    }
    sessionStarted = false
    // Continuations keep the original take's timestamp so export can stem-match
    // `program-…mp4` and `program-…-2.mp4`.
    let stamp = (continuing ? startedAt : nil)?.date ?? wall.date
    lock.unlock()

    try openPart(stamp: stamp, replacingExistingFile: true)
  }

  /// Picks up a take this process did not start, as another part of the same file family.
  ///
  /// The in-process recovery below can rely on knowing what it had already written. Nothing here
  /// can: the parts on disk were written by a process that is gone, and the only facts to hand
  /// are when the take began and which part number is free. That is enough.
  /// `previousPartsDuration` becomes the whole span before this instant, so `finish(until:)`
  /// fills this part out to the stop rather than out to the take, and the hole where the app was
  /// not running is left for the export to hold. Filling it here would mean encoding minutes of
  /// black on the one code path that has to be quick.
  ///
  /// Where the part sits on the wall clock needs nothing extra: its anchors are sampled from the
  /// pictures it is given, under its own part number, exactly as the first part's were.
  public func resume(startedAt take: WallClock, nextPart: Int, at wall: WallClock) throws {
    lock.lock()
    guard !isRunning else {
      lock.unlock()
      throw ProgramEncoderError.alreadyRunning
    }
    part = max(1, nextPart)
    outputURLs = []
    lastSourceTime = nil
    lastAppendHost = nil
    lastAnchorSeconds = -.infinity
    contentLagSeconds = nil
    pendingRecoveryFill = false
    // Everything up to the resume, for now. The part's own timeline begins with its first picture,
    // which after a crash comes only once a camera is delivering again — seconds after this, and in
    // a take whose cameras take half a minute to come back, half a minute after. That picture moves
    // this to where the part really starts; a part that never gets one keeps the resume.
    previousPartsDuration = max(0, wall.seconds - take.seconds)
    resumedAwaitingPicture = true
    startedAt = take
    sessionStarted = false
    lock.unlock()

    // Never replace an existing file here. A crash between opening a part and its first anchor
    // leaves a name in use that no anchor mentions, and that file holds footage.
    try openPart(stamp: take.date, replacingExistingFile: false)
  }

  private func openPart(stamp: Date, replacingExistingFile: Bool) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let stem = "program-\(formatter.string(from: stamp))"

    lock.lock()
    var seq = part
    lock.unlock()
    var url = Self.partURL(stem: stem, part: seq, in: directory)
    if replacingExistingFile {
      try? FileManager.default.removeItem(at: url)
    } else {
      while FileManager.default.fileExists(atPath: url.path) {
        seq += 1
        url = Self.partURL(stem: stem, part: seq, in: directory)
      }
      lock.lock()
      part = seq
      lock.unlock()
    }

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

    // Colour is stated rather than left to the first picture. Unstated, the encoder takes it from
    // whatever buffer comes first: a take opens on the compositor's tagged frames, but a part
    // started after a failed writer opens on the untagged black hold. rec-409's second part came out
    // with no colour tags, a format its first part's track would not take, and the export put it
    // on a second video track. Every part of a take must describe itself identically.
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
      ],
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
    self.hostOrigin = nil
    self.partStartHost = nil
    self.lastAppendHost = nil
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

  private static func partURL(stem: String, part: Int, in directory: URL) -> URL {
    let suffix = part == 1 ? "" : "-\(part)"
    return directory.appendingPathComponent("\(stem)\(suffix).mp4")
  }

  /// `pixelBuffer` may be BGRA straight out of the compositor; it is converted once here.
  /// `captureWall` is when the on-air camera captured this picture, for a live frame. Nil for a
  /// replay frame or a source that does not know.
  public func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime, captureWall: WallClock? = nil) {
    lock.lock()
    if poisonFinishing {
      lock.unlock()
      return
    }
    guard isRunning, let writer, let adaptor, let videoInput else {
      lock.unlock()
      return
    }
    if Self.isTerminal(writer.status) {
      lock.unlock()
      recoverDeadWriter()
      return
    }
    if pendingRecoveryFill {
      pendingRecoveryFill = false
      let gap = lastSourceTime.map { max(0, CMTimeSubtract(presentationTime, $0).seconds) } ?? 0
      lock.unlock()
      fillHold(seconds: gap)
      lock.lock()
      guard isRunning, !Self.isTerminal(writer.status) else {
        lock.unlock()
        return
      }
      // Always remap this source time onto the file timeline. fillHold used to set
      // `baseTime = .zero` and return on a tiny gap, so the next live sample kept
      // compositor PTS (boot-time, ~days) in the continuation file.
      let origin: CMTime
      if lastTime.isNumeric, lastTime >= .zero {
        origin = CMTimeAdd(lastTime, CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1))))
      } else {
        origin = .zero
      }
      baseTime = CMTimeSubtract(presentationTime, origin)
    }
    if baseTime == nil {
      baseTime = presentationTime
      // A resumed part starts here. Left at the resume instead, `finish(until:)` would fill the part
      // out to the stop as if it had been running since the resume, and write the whole wait for
      // the cameras a second time at the end of the file — as fast as it can, while live pictures
      // still arriving pick their timestamps up from that fill and anchor it as real time.
      if resumedAwaitingPicture, let startedAt {
        resumedAwaitingPicture = false
        previousPartsDuration = max(0, Date().timeIntervalSince1970 - startedAt.seconds)
      }
      if !sessionStarted {
        writer.startSession(atSourceTime: .zero)
        sessionStarted = true
      }
    }
    guard let base = baseTime else {
      lock.unlock()
      return
    }
    _ = base
    let oneFrame = CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1)))
    // The programme is what went out, when it went out: each frame is placed on the host clock it
    // was composed on, since the part began. That is the clock the programme's audio is mixed and
    // placed on, so picture and sound stay locked however the display delay moves.
    //
    // The source's own timestamps only set the spacing between frames, which they do evenly where
    // arrival jitters, and the timeline is steered back to real time a tenth of the error at a
    // time. They are not trusted for position: an NDI camera's advance one measured frame period
    // per frame, so a rate estimate a few percent low ran rec-407's programme master 9% fast for
    // five minutes, and they need not show an outage at all — rec-406's NDI source came back from 18
    // s of nothing one frame on, and the picture ran 18.6 s ahead of its sound from then on. Capture
    // time was tried and is the wrong clock here: it moved the picture 0.47 s ahead of the sound when
    // the display delay settled after a take began, and copied the Cosmo's paired stamps into the
    // frame timing as judder. Any error past a quarter of a second is a stall or an outage, and the
    // timeline goes straight to real time, which holds the picture across it.
    let nowHost = CFAbsoluteTimeGetCurrent()
    if partStartHost == nil { partStartHost = nowHost }
    let hasTimeline = lastTime.isNumeric && lastTime >= .zero
    if hostOrigin == nil {
      hostOrigin = nowHost - (hasTimeline ? CMTimeAdd(lastTime, oneFrame).seconds : 0)
    }
    let hostSeconds = nowHost - (hostOrigin ?? nowHost)
    var time: CMTime
    if hasTimeline {
      let sourceStep = lastSourceTime.map { CMTimeSubtract(presentationTime, $0).seconds } ?? 0
      let step = sourceStep > 0 && sourceStep < Self.maximumSourceStep ? sourceStep : oneFrame.seconds
      let predicted = lastTime.seconds + step
      let error = hostSeconds - predicted
      let seconds = abs(error) > Self.hostReseatSeconds ? hostSeconds : predicted + Self.hostSteerGain * error
      time = CMTime(seconds: seconds, preferredTimescale: 600)
      if time <= lastTime { time = CMTimeAdd(lastTime, CMTime(value: 1, timescale: 600)) }
    } else {
      time = CMTime(seconds: max(0, hostSeconds), preferredTimescale: 600)
    }
    // A replay frame's or a recovery's arithmetic on source time stays consistent with where this
    // frame went.
    baseTime = CMTimeSubtract(presentationTime, time)
    let nowWall = Date().timeIntervalSince1970
    lastTime = time
    lastAppendHost = nowHost
    lastSourceTime = presentationTime
    // Sampled here, where the programme's own timeline is decided, so the pair is exactly what was
    // written rather than what a later reader infers.
    //
    // The wall an anchor records is when the picture was *captured*, not when it was composed. The
    // programme is built from pictures the delay line has already held for half a second, so
    // stamping composition time placed rec-401's programme master about 0.55 s behind the camera
    // files it was cut from. A live frame says exactly how old it is; a replay frame does not, so
    // it borrows the lag the last live frame measured, which keeps the timeline continuous.
    if let captureWall, nowWall - captureWall.seconds >= 0, nowWall - captureWall.seconds < 10 {
      contentLagSeconds = nowWall - captureWall.seconds
    }
    let contentWall = WallClock(seconds: nowWall - (contentLagSeconds ?? 0))
    var anchor: (recording: Int64, part: Int, seconds: Double, wall: WallClock)?
    if let recording = anchorRecordingID,
       time.isNumeric,
       time.seconds - lastAnchorSeconds >= Self.anchorIntervalSeconds {
      lastAnchorSeconds = time.seconds
      anchor = (recording, part, time.seconds, contentWall)
    }
    let sink = anchorSink
    let ready = videoInput.isReadyForMoreMediaData
    lock.unlock()

    // Outside the lock: the sink writes to the index, and there is no reason to hold the
    // compositor's append behind a database write.
    if let anchor { sink?(anchor.recording, anchor.part, anchor.seconds, anchor.wall) }

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

    // Re-checked under the lock and appended while holding it. Readiness read above was released
    // before the conversion, and `finish()` takes the writer under this same lock and then marks
    // the input finished — so a frame in flight here could reach the adaptor after that, and the
    // adaptor throws an uncaught `NSInternalInconsistencyException` for it rather than returning
    // false. That was the crash on stop after a camera reconnected: signal 6, no crash report.
    // Holding the lock across the append means `takeWriterForFinish` waits for it to land.
    lock.lock()
    guard isRunning, !poisonFinishing, let liveWriter = self.writer, let liveAdaptor = self.adaptor,
      let liveInput = self.videoInput, liveInput.isReadyForMoreMediaData
    else {
      lock.unlock()
      return
    }
    // A continuation writer opened by recovery comes up running with no session, and nothing
    // resets `baseTime`, so the session start above never fires for it. Appending to it throws
    // "Must start a session" — the second stop crash after a two-minute reconnect. Start it here,
    // under the lock, the way `fillHold` does.
    if !sessionStarted {
      liveWriter.startSession(atSourceTime: .zero)
      sessionStarted = true
    }
    if liveAdaptor.append(encodable, withPresentationTime: time) {
      writtenFrames += 1
    }
    lock.unlock()

    // A small budget: this runs on a tile's frame-delivery thread, and audio has its own callback
    // to do the bulk of the work. This is only here so a briefly unready input still gets flushed.
    drainAudio(limit: 2)
  }

  public func append(audio frame: AudioFrame) {
    let duration = Self.audioDuration(of: frame.sampleBuffer)

    lock.lock()
    if poisonFinishing {
      lock.unlock()
      return
    }
    if let writer, Self.isTerminal(writer.status) {
      lock.unlock()
      recoverDeadWriter()
      return
    }
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

  private func writerIsDead() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return writer.map { Self.isTerminal($0.status) } ?? false
  }

  private func previousPartsSeconds() -> Double {
    lock.lock()
    defer { lock.unlock() }
    return previousPartsDuration
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
      if poisonFinishing {
        lock.unlock()
        return
      }
      if let writer, Self.isTerminal(writer.status) {
        isDraining = false
        lock.unlock()
        recoverDeadWriter()
        return
      }
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

    if writerIsDead() {
      recoverDeadWriter()
    }

    if let wall, let origin = startedAt {
      fillHold(until: max(0, wall.seconds - origin.seconds - previousPartsSeconds()))
    }

    guard let pending = takeWriterForFinish() else { return nil }

    pending.videoInput?.markAsFinished()
    pending.audioInput?.markAsFinished()
    // See SegmentWriter.finish(): `await writer.finishWriting()` picks the blocking overload.
    await withCheckedContinuation { continuation in
      pending.writer.finishWriting { continuation.resume() }
    }
    // `finishWriting` reports through the writer, not through its callback. A finalise that did
    // not complete leaves the movie header unwritten, so every sample past the last movie
    // fragment stays in the file but unreadable. Going quiet here is what let a broken master sit
    // undetected until an export an hour later called it damaged media; the operator finds out at
    // stop instead, while the camera archives for the same take are still on disk.
    if pending.writer.status != .completed {
      let detail = Self.describe(pending.writer.error)
      telemetry.recordError("program master did not finalise: \(detail)")
      telemetry.mutate { $0.dvr.lastError = "program master did not finalise: \(detail)" }
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
    lastAppendHost = nil
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
    recoverWriter(force: true)
  }

  /// Fails the live program writer the way a muxer error would. Unit tests and the UITest
  /// `kill-program-writer` command call this; production cameras never do.
  public func poisonWriter() {
    lock.lock()
    guard isRunning, let writer else {
      lock.unlock()
      return
    }
    let input = audioInput
    let started = sessionStarted
    lock.unlock()

    if started, let input, let poison = Self.zeroDurationSilence() {
      _ = input.append(poison)
    }
    lock.lock()
    if Self.isTerminal(writer.status) {
      lock.unlock()
      return
    }
    // Completing the file keeps already-written samples. cancelWriting discards them
    // and leaves a 0-byte part, which is how rec-18 looked after a failed recover.
    poisonFinishing = true
    lock.unlock()
    let finished = DispatchSemaphore(value: 0)
    writer.finishWriting { finished.signal() }
    _ = finished.wait(timeout: .now() + 5)
    lock.lock()
    poisonFinishing = false
    lock.unlock()
  }

  private static func isTerminal(_ status: AVAssetWriter.Status) -> Bool {
    status == .failed || status == .cancelled || status == .completed
  }

  private static func zeroDurationSilence() -> CMSampleBuffer? {
    let frames = 1
    let channels = AudioMixer.channelCount
    let rate = AudioMixer.sampleRate
    guard
      let format = AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(
          sampleRate: rate,
          channels: UInt32(channels)
        )
      )
    else { return nil }
    let zeros = [Int16](repeating: 0, count: frames * channels)
    guard
      let buffer = AudioSampleBuilder.makeSampleBuffer(
        samples: zeros,
        formatDescription: format,
        presentationTime: .zero
      )
    else { return nil }
    var timing = CMSampleTimingInfo(
      duration: .zero,
      presentationTimeStamp: .zero,
      decodeTimeStamp: .invalid
    )
    var retimed: CMSampleBuffer?
    guard CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: buffer,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &retimed
    ) == noErr else { return nil }
    return retimed
  }

  private func recoverDeadWriter() {
    recoverWriter(force: false)
  }

  private func recoverWriter(force: Bool) {
    lock.lock()
    guard !isRecovering else {
      lock.unlock()
      return
    }
    guard let failed = writer else {
      lock.unlock()
      return
    }
    if !force, !Self.isTerminal(failed.status) {
      lock.unlock()
      return
    }
    isRecovering = true
    let code = (failed.error as NSError?)?.code ?? Int(failed.status.rawValue)
    let detail = failed.status == .cancelled
      ? "program writer cancelled: \(Self.describe(failed.error))"
      : "program writer failed: \(Self.describe(failed.error))"
    if lastTime.isNumeric, lastTime >= .zero {
      let elapsed = startedAt.map { Date().timeIntervalSince($0.date) } ?? lastTime.seconds
      previousPartsDuration += min(max(0, lastTime.seconds), max(0, elapsed) + 1)
    }
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

    telemetry.recordEncodeSessionChange(delta: -1)
    if Self.isTerminal(failed.status) {
      telemetry.recordError(detail)
      telemetry.recordEncodeFailure(code: Int32(clamping: code))
    }

    if failed.status == .failed || failed.status == .writing {
      let finished = DispatchSemaphore(value: 0)
      failed.finishWriting { finished.signal() }
      _ = finished.wait(timeout: .now() + 2)
    } else if failed.status == .unknown {
      failed.cancelWriting()
    }
    let wall = WallClock(date: Date())
    do {
      try start(at: wall)
    } catch {
      telemetry.recordError("program writer recover failed: \(error)")
      try? start(at: wall)
    }
    lock.lock()
    isRecovering = false
    lock.unlock()
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
    guard isRunning, !poisonFinishing, let writer, let adaptor, let videoInput,
      videoInput.isReadyForMoreMediaData
    else {
      lock.unlock()
      return
    }
    if !sessionStarted {
      writer.startSession(atSourceTime: .zero)
      sessionStarted = true
    }
    lastTime = time
    // Appended under the lock for the same reason as the live path: released between the check
    // and the append, `finish()` can mark the input finished in the gap and the adaptor throws.
    if adaptor.append(pixelBuffer, withPresentationTime: time) {
      writtenFrames += 1
    }
    lock.unlock()
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
    case alreadyRunning

    public var description: String {
      switch self {
      case .writerRejectedInput: "program writer rejected the video input"
      case let .startFailed(reason): "program writer failed to start: \(reason)"
      case .alreadyRunning: "program writer is already running"
      }
    }
  }
}
