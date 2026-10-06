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
/// Where the programme's sound goes. `AVAssetWriterInput` in production; a fake in tests, which is
/// the only way to make a writer refuse on demand — and a writer that refuses is precisely the
/// condition that killed the 2026-09-21 soak, so it has to be reachable without one.
protocol SoundSink: AnyObject {
  var isReadyForMoreSound: Bool { get }
  func appendSound(_ sample: CMSampleBuffer) -> Bool
  func finishSound()
}

extension AVAssetWriterInput: SoundSink {
  var isReadyForMoreSound: Bool { isReadyForMoreMediaData }
  func appendSound(_ sample: CMSampleBuffer) -> Bool { append(sample) }
  func finishSound() { markAsFinished() }
}

public final class ProgramEncoder: @unchecked Sendable {
  public private(set) var outputURL: URL?

  private var anchorSink: AnchorSink?
  private var soundCheckSink: SoundCheckSink?
  private var anchorRecordingID: Int64?
  /// Which recording this part belongs to, latched when it writes its first anchor.
  ///
  /// Not `anchorRecordingID`, which the owner clears at the *start* of the stop path so the tail
  /// fill's frames are not anchored — it is already nil by the time `finish` runs. Latching on an
  /// anchor also means a programme being previewed with no take rolling never claims one, because
  /// it writes no anchors.
  private var partRecordingID: Int64?
  private let telemetry: PipelineTelemetry
  private let converter: PixelConverter
  /// The encoding the current part is written with; see `configure(_:)`.
  private var width: Int
  private var height: Int
  private var bitrate: Int
  private var frameRate: Int
  private var gopSeconds: Double
  private var codec: ProgramCodec
  private let directory: URL

  private let lock = NSLock()
  private var writer: AVAssetWriter?
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  /// Overridden by tests; otherwise the writer's own sound input. See `SoundSink`.
  var soundSinkOverride: SoundSink?
  private var soundSink: SoundSink? { soundSinkOverride ?? audioInput }
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  private var baseTime: CMTime?
  private var lastTime: CMTime = .negativeInfinity
  /// Audio needs its own base: a source's audio and video timestamps need not share a timebase.
  /// See `SegmentWriter` — a camera's audio and video clocks run independently.
  private var baseAudioTime: CMTime?
  /// Where this part's timeline begins on the wall clock, settled at its opening and then held.
  /// See `ProgrammeSoundOrigin` — this replaced a per-frame estimate that cost take 900 50.00 s.
  private var soundOrigin = ProgrammeSoundOrigin()
  /// One chunk of the mix waiting for the writer, with where wall clock says it belongs.
  ///
  /// The sample is kept **untimed** on purpose. Its position is assigned in `drainAudio`, at the
  /// moment the writer takes it, from `writtenAudioEnd`. Stamping at queue time read a cursor that
  /// only advances on acceptance, so every chunk queued while the input was unready got the *same*
  /// timestamp — and an `AVAssetWriter` audio input fails on a timestamp that does not increase.
  /// That is what killed the writer five minutes into the 2026-09-21 soak.
  struct PendingSound {
    let sample: CMSampleBuffer
    /// Seconds on this part's timeline, from `ProgrammeSoundOrigin`.
    let target: Double
    let duration: CMTime
  }

  /// Audio awaiting a writer that is not currently accepting it. Discarding instead of queueing
  /// leaves the audio track short of the video track, which stalls the muxer outright.
  private var pendingAudio: [PendingSound] = []
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
  /// Host time of the last frame actually placed on the programme timeline.
  ///
  /// The programme is watched afterwards, so its timeline has to be real time even across a
  /// stall. Without this, a frame arriving on a foreign timebase advanced the file by exactly one
  /// frame however long the compositor had been away, and the master ended shorter than the take
  /// it came from, accumulating at each
  /// stall and never recovering.
  private var lastAppendHost: Double?
  /// Uptime at which this part's grid reads slot zero. Set at the part's first frame, so a
  /// continuation after a recovery fill carries on from the held timeline.
  private var hostZero: Double?
  /// How many frame periods a frame's own slot may stray from real time's before real time's slot
  /// is used. The programme clock's frames stay within half a frame, since the clock numbers them
  /// from real time; one and a half keeps a source whose timestamps run fast within a frame of it.
  private static let gridSlack: Double = 1.5
  /// The longest fill written frame by frame on the programme's grid; see `fillHold(until:)`.
  private static let gridFillSeconds: Double = 30
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
  /// Sound buffers the writer refused. Counted because losing them silently is indistinguishable
  /// from never having recorded them.
  private var audioAppendFailures = 0
  /// Sound dropped because the queue was full. Silent loss until it is counted.
  private var audioQueueDrops = 0
  /// Sound the placement accepted that never reached the queue.
  private var audioPlacedNotQueued = 0
  /// Sound offered for a moment the track has already passed. A gapless mixer cannot produce one,
  /// so a non-zero count is a bug upstream rather than ordinary lateness.
  private var audioBehindTrack = 0
  /// Diagnostics for the sound path, reported at finish.
  private var audioOffered = 0
  private var audioUnseeded = 0
  private var audioBeforePart = 0
  private var audioFirstTarget = -1.0
  private var audioLastTarget = -1.0
  private var audioLongestSpan = 0.0
  private var silenceQueued = 0
  /// Where the last buffer the writer accepted ends, and how many it took. Reset with the part, so
  /// this is about the part being finished and not something an earlier one left behind.
  private var acceptedAudioCount = 0
  /// How much sound the writer has taken, summed as it takes it. The track is laid contiguously, so
  /// this is where it ends — and it is what the hold at Stop has to fill from.
  private var writtenAudioEnd = 0.0
  /// The finish's own numbers, kept so what the file turned out to hold can be added to them.
  private var lastProgramFinishDetail = ""

  /// Eight seconds of the mix's 20 ms chunks: at Stop the recording's mix hands over the five it
  /// was still waiting on at once.
  private static let maximumPendingAudio = 400
  /// One chunk of synthesised silence, in seconds.
  private static let silenceChunkSeconds = Double(1_024) / AudioMixer.sampleRate
  /// The most silence the tail at Stop will synthesise, in 21 ms chunks: about two minutes. A
  /// legitimate tail is the mix's wait, seconds at most. Anything beyond this is a cursor that has
  /// come adrift, and filling it would cost more than the sound is worth.
  private static let maximumHoldSilence = 5_600
  /// Longest the tail at Stop will keep trying. Past this the writer is not coming back and the
  /// stop path matters more than the last of the sound.
  private static let holdSilenceDeadlineSeconds: Double = 8


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

  /// The clock the anchors and the parts are timed on: the one the pictures' capture times and
  /// `start(at:)` come from (the steady wall clock in the app), never the device's own, which steps.
  private let clock: DirectorClock

  public init(
    telemetry: PipelineTelemetry,
    converter: PixelConverter,
    config: AppConfig,
    directory: URL = DirectorPaths.program,
    clock: DirectorClock = SystemClock()
  ) {
    self.clock = clock
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

  /// The encoding the next part is written with: the take's programme settings, so a take records
  /// with the settings in force when it began rather than the ones the app was launched with. A part
  /// already being written keeps what it started with, so this is ignored while running.
  public func configure(_ encoding: EncodeSettings) {
    lock.lock()
    defer { lock.unlock() }
    guard !isRunning else { return }
    width = encoding.resolution.width
    height = encoding.resolution.height
    bitrate = encoding.bitrate
    frameRate = encoding.frameRate
    gopSeconds = encoding.keyframeSeconds
    codec = encoding.codec
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

  /// Called once per finished part with what its sound track turned out to hold.
  ///
  /// A closure for the same reason `AnchorSink` is one: the encoder has no business knowing where
  /// takes are stored, and the owner decides which recording the verdict belongs to.
  public typealias SoundCheckSink = @Sendable (_ recordingID: Int64, _ check: ProgramSoundCheck) -> Void

  public func setSoundCheckSink(_ sink: SoundCheckSink?) {
    lock.lock()
    soundCheckSink = sink
    lock.unlock()
  }

  /// Which recording and part the writer being finished belongs to.
  private func finishedIdentity() -> (Int64?, Int) {
    lock.lock()
    defer { lock.unlock() }
    return (partRecordingID, part)
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
      partRecordingID = nil
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
    self.lastAppendHost = nil
    self.hostZero = nil
    self.baseAudioTime = nil
    self.acceptedAudioCount = 0
    self.writtenAudioEnd = 0
    self.resetSoundDiagnosticsLocked()
    self.lastTime = .negativeInfinity
    self.writtenFrames = 0
    self.soundOrigin.reset()
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
  /// replay frame or a source that does not know. `onClockGrid` says `presentationTime` is the
  /// programme clock's own frame number, which is trusted as it stands; any other time is checked
  /// against real time first.
  public func append(
    _ pixelBuffer: CVPixelBuffer,
    presentationTime: CMTime,
    captureWall: WallClock? = nil,
    onClockGrid: Bool = false
  ) {
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
    let continuingAfterRecovery = pendingRecoveryFill
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
        previousPartsDuration = max(0, clock.now.seconds - startedAt.seconds)
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
    let oneFrame = CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1)))
    // The programme is what went out, when it went out, on the programme clock's own grid: each
    // frame goes at the time the clock gave it, counted from the part's first frame, so the master
    // is an exact constant frame rate and an export can copy it as it is. The clock counts real
    // time, so a stall of the clock itself advances the timeline by the stall and holds the picture
    // across it. Camera timestamps never reach here: the clock replaced them after an NDI camera's
    // ran rec-407's master 9% fast and rec-406's came back from 18 s of nothing one frame on. The
    // programme's sound is placed by the origin this part settled at its opening, which is taken
    // from the same content wall the anchors record; see `ProgrammeSoundOrigin`.
    //
    // Every frame goes in a slot of the part's grid, one frame period apart. A frame on the clock's
    // grid takes the slot its number names, repeats of numbers a late timer skipped included, since
    // those arrive together and late by design; only one that goes back, the clock restarted for a
    // new rate, is placed by real time. Any other frame takes the slot its time names unless that is
    // more than `gridSlack` frames from real time's slot since the part began, when real time's slot
    // wins and later frames follow on from it: a source whose own timestamps run fast stays within a
    // frame of real time. Either way the frame lands exactly on the grid. A frame whose slot is
    // already written is a second picture in one frame period, a source faster than the grid, and
    // is left out: the grid holds one picture a slot.
    let nowHost = ProcessInfo.processInfo.systemUptime
    let hasTimeline = lastTime.isNumeric && lastTime >= .zero
    let rate = Double(max(frameRate, 1))
    let lastSlot = hasTimeline ? Int64((lastTime.seconds * rate).rounded()) : -1
    if hostZero == nil { hostZero = nowHost - Double(lastSlot + 1) / rate }
    let hostSlot = Int64(((nowHost - (hostZero ?? nowHost)) * rate).rounded())
    let source = CMTimeSubtract(presentationTime, base)
    var slot = source.isNumeric ? Int64((source.seconds * rate).rounded()) : hostSlot
    if onClockGrid {
      if slot <= lastSlot { slot = max(hostSlot, lastSlot + 1) }
    } else if !continuingAfterRecovery, Double(abs(slot - hostSlot)) > Self.gridSlack {
      slot = hostSlot
    }
    guard slot > lastSlot else {
      lock.unlock()
      return
    }
    let time = CMTime(value: slot, timescale: CMTimeScale(max(frameRate, 1)))
    // A replay frame's or a recovery's arithmetic on source time stays consistent with where this
    // frame went.
    baseTime = CMTimeSubtract(presentationTime, time)
    let nowWall = clock.now.seconds
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
    // The sound's origin comes from the same quantity the anchors publish — content wall less
    // where the picture was placed — so the master's lip sync and its placement against the take's
    // camera archives derive from one number. Ignored once settled.
    soundOrigin.offer(
      impliedPartStart: contentWall.seconds - time.seconds,
      atProgramme: time.seconds
    )
    var anchor: (recording: Int64, part: Int, seconds: Double, wall: WallClock)?
    if let recording = anchorRecordingID,
       time.isNumeric,
       time.seconds - lastAnchorSeconds >= Self.anchorIntervalSeconds {
      lastAnchorSeconds = time.seconds
      anchor = (recording, part, time.seconds, contentWall)
      partRecordingID = recording
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

  /// The recording's own mix, placed by the one origin this part settled at its opening.
  ///
  /// This only decides *whether* a chunk belongs to the part and hands it to the queue with the
  /// moment it belongs at. Where it lands in the file is `drainAudio`'s business, because only the
  /// writer's acceptance moves the track on. See `PendingSound`.
  public func append(audio frame: AudioFrame) {
    let duration = Self.audioDuration(of: frame.sampleBuffer)

    lock.lock()
    if poisonFinishing {
      lock.unlock()
      return
    }
    // `isRunning` first, exactly as the video path has always ordered it. `takeWriterForFinish`
    // clears `isRunning` but leaves `self.writer` set until `clearWriter()`, which is the last
    // thing `finish` does — after `finishWriting` and two full reader passes. The recording mix is
    // never stopped at Stop, so it resumes at 50 Hz five seconds after the flush; a chunk landing
    // in that window used to see a `.completed` writer, call `recoverDeadWriter()`, open a phantom
    // part, and leave `isRunning` true with no writer. The *next* take's `start()` then returned
    // silently and recorded no programme master at all. The window widens with take length.
    guard isRunning, audioInput != nil, baseTime != nil, duration.isNumeric, duration > .zero else {
      lock.unlock()
      return
    }
    if let writer, Self.isTerminal(writer.status) {
      lock.unlock()
      recoverDeadWriter()
      return
    }
    audioOffered += 1
    if duration.seconds > audioLongestSpan { audioLongestSpan = duration.seconds }
    // Nil before the opening has been sampled, and for sound captured before the part began.
    // Neither is a loss: the mix runs seconds behind, so this part's own first sound arrives
    // long after the origin has settled.
    guard let target = soundOrigin.timeline(forCaptureWall: frame.wallClock.seconds) else {
      if soundOrigin.isSettled { audioBeforePart += 1 } else { audioUnseeded += 1 }
      lock.unlock()
      return
    }
    if audioFirstTarget < 0 { audioFirstTarget = target }
    audioLastTarget = target

    pendingAudio.append(PendingSound(sample: frame.sampleBuffer, target: target, duration: duration))
    if pendingAudio.count > Self.maximumPendingAudio {
      // The queue stays bounded, and this no longer costs the timeline: `writtenAudioEnd` only
      // advances on buffers the writer took, so the next chunk's fill covers whatever these held.
      // Still loud, because it means the writer is not keeping up and the sound has a hole in it.
      let lost = pendingAudio.count - Self.maximumPendingAudio
      audioQueueDrops += lost
      pendingAudio.removeFirst(lost)
      telemetry.recordError("program sound queue overflowed, \(lost) buffer(s) of sound lost")
    }
    lock.unlock()

    drainAudio(limit: 8)
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

  /// Hands sound to the writer: at most `limit` appends, and it is the **only** thing that ever
  /// touches the sound input or moves `writtenAudioEnd`.
  ///
  /// Both bounds matter, and the program encoder is where it shows. Its video arrives from the
  /// compositor while its audio arrives from every source's own capture thread, so several threads
  /// reach this at once — and `append` is called synchronously from each tile's frame-delivery
  /// thread, so a thread that sits here draining a long queue stalls that tile's video. Unbounded
  /// and unserialised, this produced quarter-second stutters and dropped frames by the hundred.
  ///
  /// `fillUntil` is how the tail at Stop asks for silence: once the queue is empty, pad the track
  /// to that time. It goes through here rather than writing to the input itself, because two
  /// writers sharing a cursor is not one writer — each would read the same `writtenAudioEnd` and
  /// stamp the same instant, which is the failure this whole rewrite is about.
  ///
  /// The lock is held **across** the append, the way the video path has held it since the crash at
  /// `signal 6` with no report: `finish` marks the input finished under the same lock, and an
  /// append that races that traps inside AVFoundation.
  private func drainAudio(limit: Int, fillUntil: Double? = nil) {
    lock.lock()
    if isDraining {
      lock.unlock()
      return
    }
    isDraining = true
    lock.unlock()

    var recoverAfterwards = false
    defer {
      lock.lock()
      isDraining = false
      lock.unlock()
      // Outside the flag, never while holding it: `recoverWriter` opens a writer and must not run
      // with this thread still claiming to be the drainer.
      if recoverAfterwards { recoverDeadWriter() }
    }

    var drained = 0
    while drained < limit {
      lock.lock()
      if poisonFinishing {
        lock.unlock()
        return
      }
      guard isRunning else {
        lock.unlock()
        return
      }
      if let writer, Self.isTerminal(writer.status) {
        lock.unlock()
        recoverAfterwards = true
        return
      }
      guard let sink = soundSink, sink.isReadyForMoreSound else {
        lock.unlock()
        return
      }

      // The track is laid contiguously, so its position is wherever the writer has got to. A
      // shortfall against where wall clock says the head belongs is covered with coded silence
      // first; a chunk the track has already passed is dropped rather than written over sound the
      // file holds. Decided and acted on in one critical section, against a cursor only acceptance
      // moves, so no two buffers can be stamped with the same instant.
      let start = max(writtenAudioEnd, 0)
      let sample: CMSampleBuffer
      let span: Double
      let isFill: Bool

      if let next = pendingAudio.first {
        let slack = next.duration.seconds / 2
        if next.target > start + slack {
          guard let silence = makeSilenceLocked(at: start) else { lock.unlock(); return }
          (sample, span, isFill) = (silence.sample, silence.duration.seconds, true)
        } else if next.target < start - slack {
          pendingAudio.removeFirst()
          audioBehindTrack += 1
          lock.unlock()
          drained += 1
          continue
        } else {
          guard let retimed = Self.retimed(next.sample, to: start, rate: AudioMixer.sampleRate),
                next.duration.isNumeric, next.duration > .zero
          else {
            pendingAudio.removeFirst()
            audioPlacedNotQueued += 1
            lock.unlock()
            drained += 1
            continue
          }
          (sample, span, isFill) = (retimed, next.duration.seconds, false)
        }
      } else if let fillUntil, start + Self.silenceChunkSeconds / 2 < fillUntil {
        // Only with nothing real waiting, so the tail never jumps the queue and pushes the cursor
        // past sound that is about to be written.
        guard let silence = makeSilenceLocked(at: start) else { lock.unlock(); return }
        (sample, span, isFill) = (silence.sample, silence.duration.seconds, true)
      } else {
        lock.unlock()
        return
      }

      let accepted = sink.appendSound(sample)
      if accepted {
        writtenAudioEnd += span
        if isFill {
          silenceQueued += 1
        } else {
          acceptedAudioCount += 1
          pendingAudio.removeFirst()
        }
      } else {
        // The head stays queued, so a refusal costs latency and never position — but this pass is
        // over. Retrying the same buffer inside the same call is how `limit: .max` became an
        // infinite loop against a writer that had stopped taking sound altogether.
        audioAppendFailures += 1
        lock.unlock()
        return
      }
      lock.unlock()
      drained += 1
    }
  }

  /// One chunk of coded silence starting at `seconds`. Called with `lock` held.
  private func makeSilenceLocked(at seconds: Double) -> (sample: CMSampleBuffer, duration: CMTime)? {
    let frames = 1_024
    let rate = AudioMixer.sampleRate
    let channels = AudioMixer.channelCount
    guard
      let format = AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(sampleRate: rate, channels: UInt32(channels))
      ),
      let buffer = AudioSampleBuilder.makeSampleBuffer(
        samples: [Int16](repeating: 0, count: frames * channels),
        formatDescription: format,
        presentationTime: CMTime(seconds: max(0, seconds), preferredTimescale: CMTimeScale(rate))
      )
    else { return nil }
    return (buffer, CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(rate)))
  }

  /// A copy of `sample` presented at `seconds`.
  ///
  /// The timing entry's `duration` is the duration of one **sample**, not of the buffer. Giving it
  /// the buffer's own span made `CMSampleBufferGetDuration` report 960x too much.
  private static func retimed(
    _ sample: CMSampleBuffer,
    to seconds: Double,
    rate: Double
  ) -> CMSampleBuffer? {
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: CMTimeScale(rate)),
      presentationTimeStamp: CMTime(seconds: max(0, seconds), preferredTimescale: CMTimeScale(rate)),
      decodeTimeStamp: .invalid
    )
    var copy: CMSampleBuffer?
    guard CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sample,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &copy
    ) == noErr else { return nil }
    return copy
  }


  /// What the finished part's sound track actually holds: how many samples, and the span they cover.
  ///
  /// Read with `AVAssetReader` rather than trusted from the track's `timeRange`, because the whole
  /// question is whether the samples handed to the writer are in the file.
  private static func soundSamples(of url: URL) async -> (count: Int, first: Double, last: Double) {
    let asset = AVURLAsset(url: url)
    guard let track = try? await asset.loadTracks(withMediaType: .audio).first,
          let reader = try? AVAssetReader(asset: asset)
    else { return (-1, -1, -1) }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return (-1, -1, -1) }
    reader.add(output)
    reader.startReading()
    var count = 0
    var first = -1.0
    var last = -1.0
    while let sample = output.copyNextSampleBuffer() {
      let n = CMSampleBufferGetNumSamples(sample)
      guard n > 0 else { continue }
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      let duration = CMSampleBufferGetDuration(sample)
      if pts.isNumeric {
        if first < 0 { first = pts.seconds }
        let end = duration.isNumeric ? CMTimeAdd(pts, duration) : pts
        last = max(last, end.seconds)
      }
      count += 1
    }
    return (count, first, last)
  }

  /// Where each track of a finished part ends, -1 when there is no such track.
  ///
  /// The end, not the duration: the sound track starts later than the picture — the mix's first
  /// buffer lands after the first frame — so comparing durations makes a sound track that outlasts
  /// its picture look half a second short.
  private static func writtenSeconds(of url: URL) async -> (picture: Double, sound: Double) {
    let asset = AVURLAsset(url: url)
    func end(_ type: AVMediaType) async -> Double {
      guard let track = try? await asset.loadTracks(withMediaType: type).first,
            let range = try? await track.load(.timeRange)
      else { return -1 }
      return range.end.seconds
    }
    return (await end(.video), await end(.audio))
  }

  private func appendFailures() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return audioAppendFailures
  }

  private func queueDrops() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return audioQueueDrops
  }

  /// The floor the hold fills from: the sound the writer has taken, summed as it took it.
  /// Why sound was or was not written, for tests and for the finish line.
  var soundDiagnosticsForTesting: (
    origin: Double, offered: Int, unseeded: Int, beforePart: Int, behind: Int,
    first: Double, last: Double, longest: Double, silence: Int
  ) { soundDiagnostics() }

  /// How many real mix chunks the writer took, so a test can assert it exercised the writer and
  /// not just the silence fill.
  var acceptedSoundCountForTesting: Int { accepted().count }

  /// The track's position, for tests that must assert a refusal did not move it.
  var writtenSoundEndForTesting: Double { writtenSoundEnd() }

  private func writtenSoundEnd() -> Double {
    lock.lock()
    defer { lock.unlock() }
    return writtenAudioEnd
  }

  private func accepted() -> (end: Double, count: Int) {
    lock.lock()
    defer { lock.unlock() }
    return (writtenAudioEnd, acceptedAudioCount)
  }

  private func placedNotQueued() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return audioPlacedNotQueued
  }

  /// Cleared with the writer, so the counters describe the part being finished and not the app's
  /// whole session. Leaving them cumulative made `offered` unreconcilable against `accepted`,
  /// which reset per part, and cost an hour chasing a discrepancy that was only bookkeeping.
  private func resetSoundDiagnosticsLocked() {
    audioOffered = 0
    audioUnseeded = 0
    audioBeforePart = 0
    audioBehindTrack = 0
    audioFirstTarget = -1
    audioLastTarget = -1
    audioLongestSpan = 0
    silenceQueued = 0
  }

  private func soundDiagnostics() -> (
    origin: Double, offered: Int, unseeded: Int, beforePart: Int, behind: Int,
    first: Double, last: Double, longest: Double, silence: Int
  ) {
    lock.lock()
    defer { lock.unlock() }
    return (
      soundOrigin.partStartWall ?? -1, audioOffered, audioUnseeded, audioBeforePart,
      audioBehindTrack, audioFirstTarget, audioLastTarget, audioLongestSpan, silenceQueued
    )
  }

  /// Where the picture and the sound have each reached on the part's own timeline.
  private func trackEnds() -> (picture: Double, sound: Double) {
    lock.lock()
    defer { lock.unlock() }
    // `writtenAudioEnd` and not a placement cursor: the track is laid contiguously, so the sum of
    // what the writer accepted *is* where the sound ends. A cursor that ran ahead of the file is
    // what told the hold at Stop there was nothing left to fill.
    return (lastTime.isNumeric ? lastTime.seconds : -1, writtenAudioEnd)
  }

  /// Drains queued sound, waiting for the writer to accept more, up to `seconds`.
  ///
  /// `drainAudio` returns at the first refusal by design — it runs on tile frame-delivery threads
  /// and must not block them. At Stop there is no such thread to protect, and giving up on the
  /// first refusal is exactly what truncates the track.
  private func drainAudioUntilEmpty(seconds: Double) async {
    let deadline = Date().addingTimeInterval(seconds)
    while true {
      // Bounded, so the deadline below is actually checked. `.max` here is what let the
      // head-fill branch run `gap / 21 ms` appends inside a single call — the same shape that
      // wedged the stop path on 2026-09-21, reachable whenever the cursor is far behind wall
      // clock (an audio source that joins late leaves `AudioMixer.emitCursor` nil and the track
      // at zero while real time runs on).
      drainAudio(limit: 512)
      if pendingAudioCount() == 0 || Date() >= deadline { break }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
  }

  public func finish(until wall: WallClock? = nil) async -> URL? {
    // Read before anything is torn down: `clearWriter` resets the part, and the owner clears the
    // anchor recording as it stops, so both have to be taken while they still name this part.
    let (finishedRecordingID, finishedPart) = finishedIdentity()

    // Before the writer is taken away, or the tail of the audio track is discarded. Waiting matters
    // here: a writer that is not accepting audio at this instant usually is a moment later, and
    // giving up on the first refusal truncates the track. See `SegmentWriter.finish`.
    await drainAudioUntilEmpty(seconds: 2)

    if writerIsDead() {
      recoverDeadWriter()
    }

    if let wall, let origin = startedAt {
      let target = max(0, wall.seconds - origin.seconds - previousPartsSeconds())
      let (pictureAt, soundAt) = trackEnds()
      let queuedBefore = pendingAudioCount()
      fillHold(until: target)
      // `fillHold` queues the tail's silence and drains once. One drain stops at the first refusal,
      // and the tail is hundreds of buffers — the length of the mix's wait for late sound — so a
      // single pass routinely leaves most of them behind, and taking the writer next discards them.
      // That is how every master in the 2026-09-16 soak ended with its picture at the take's length
      // and its sound seven to ten seconds short of it. Wait for them the same way as above.
      await drainAudioUntilEmpty(seconds: 10)
      let soundAfter = trackEnds().sound
      lastProgramFinishDetail = String(
        format: "target %.3f picture %.3f sound %.3f->%.3f queued %d->%d refused %d dropped %d lost %d accepted %d written %.3f (=%.3f) | origin %.3f offered %d unseeded %d beforePart %d behind %d tgt %.3f..%.3f longest %.3f silence %d",
        target, pictureAt, soundAt, soundAfter, queuedBefore, pendingAudioCount(), appendFailures(),
        queueDrops(), placedNotQueued(), accepted().count, accepted().end, writtenSoundEnd(),
        soundDiagnostics().origin, soundDiagnostics().offered, soundDiagnostics().unseeded,
        soundDiagnostics().beforePart, soundDiagnostics().behind, soundDiagnostics().first,
        soundDiagnostics().last, soundDiagnostics().longest, soundDiagnostics().silence
      )
      telemetry.recordProgramFinish(lastProgramFinishDetail)
    }

    // What is still queued here cannot be written: the inputs are about to be marked finished. It
    // is silent truncation, so it is counted rather than left to be found in an export months later.
    let stranded = pendingAudioCount()
    if stranded > 0 {
      telemetry.recordError("program finish left \(stranded) audio buffers unwritten")
    }

    guard let pending = takeWriterForFinish() else { return nil }

    pending.videoInput?.markAsFinished()
    pending.soundSink?.finishSound()
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

    // What the file actually holds, not what the encoder believes it wrote: a buffer the writer
    // accepted is not evidence that it reached the file, and a master whose sound falls short of
    // its picture is the one fault nothing downstream can repair.
    var picture = -1.0
    var sound = -1.0
    if let url = pending.url {
      (picture, sound) = await Self.writtenSeconds(of: url)
    }
    var samples = (count: -1, first: -1.0, last: -1.0)
    if let url = pending.url {
      samples = await Self.soundSamples(of: url)
    }
    let detail = lastProgramFinishDetail
      + String(format: " ends picture %.3f sound %.3f", picture, sound)
      + String(format: " | in file %d samples %.3f..%.3f", samples.count, samples.first, samples.last)
    telemetry.recordProgramFinish(detail)

    // Telemetry is memory: the next take overwrites it and a relaunch loses it, which is how two
    // games' worth of this went unread. The verdict goes to the take's own row as well, where an
    // export or an upload can still see it weeks later. Same sink pattern as the anchors, so the
    // encoder still knows nothing about storage.
    let check = ProgramSoundCheck(
      part: finishedPart,
      pictureSeconds: picture,
      soundSeconds: sound,
      samples: samples.count,
      detail: detail
    )
    if let recording = finishedRecordingID { soundCheckSink?(recording, check) }

    if check.isShort {
      telemetry.recordError(
        String(format: "program master sound %.3f s short of its picture", check.shortfall)
      )
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
    /// Where sound went, so a test's fake is finished too and can prove no append outlives it.
    let soundSink: SoundSink?
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
    return PendingFinish(
      writer: writer,
      videoInput: videoInput,
      soundSink: soundSinkOverride ?? audioInput,
      url: outputURL
    )
  }

  private func clearWriter() {
    lock.lock()
    defer { lock.unlock() }
    writer = nil
    videoInput = nil
    audioInput = nil
    adaptor = nil
    soundOrigin.reset()
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
    // Under the lock, like every other append: this is a second writer otherwise, and it stamps
    // PTS zero. Only tests and the UITest `kill-program-writer` reach it, but a soak runs with
    // `-uiTest true`, so "test only" is not the same as "cannot happen tonight".
    //
    // Deliberately the writer's own input and not `soundSink`: the point is to break the real
    // writer, and a test that has substituted a fake has nothing here worth breaking.
    if sessionStarted, let input = audioInput, let poison = Self.zeroDurationSilence() {
      _ = input.append(poison)
    }
    lock.unlock()

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
      let elapsed = startedAt.map { clock.now.seconds - $0.seconds } ?? lastTime.seconds
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
    soundOrigin.reset()
    acceptedAudioCount = 0
    writtenAudioEnd = 0
    resetSoundDiagnosticsLocked()
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
    let wall = clock.now
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
  /// A fill of up to `gridFillSeconds` is one frame at a time on the programme's own grid, so the
  /// stretch is the same constant frame rate as the rest of the file: the tail at Stop and a writer
  /// recovery's hold. At ten a second, as every fill once was, those left 0.1 s frames in an
  /// otherwise exact master. A longer fill is a programme that had no picture at all, and stays at
  /// 10 fps: duration is the last PTS, and a long empty programme must finish inside the stop-path
  /// deadline rather than encode thousands of duplicate frames.
  private func fillHold(until end: Double) {
    lock.lock()
    guard isRunning, let writer else {
      lock.unlock()
      return
    }
    if !sessionStarted {
      writer.startSession(atSourceTime: .zero)
      sessionStarted = true
    }
    let frame = CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1)))
    let start = (lastTime.isNumeric && lastTime >= .zero) ? CMTimeAdd(lastTime, frame) : .zero
    let step = end - start.seconds <= Self.gridFillSeconds ? frame : CMTime(value: 1, timescale: 10)
    lock.unlock()

    // The sound is filled whichever way the picture goes. The compositor usually carries the picture
    // to the take's length by itself, so there is nothing to add to it — and when the fill returned
    // early on that, it took the sound's fill with it and the master ended with its sound short of
    // its picture.
    // To the take's length or the last picture, whichever is later. The compositor can carry the
    // picture a frame or two past the window the stop asks for, and sound that stops at the window
    // is still short of the picture beside it.
    defer {
      lock.lock()
      let pictureEnd = lastTime.isNumeric && lastTime >= .zero ? CMTimeAdd(lastTime, frame).seconds : 0
      lock.unlock()
      appendHoldSilence(until: CMTime(seconds: max(0, max(end, pictureEnd)), preferredTimescale: 600))
    }

    guard end - start.seconds > 0.0005 else { return }
    guard let black = programBlackBuffer() else { return }
    var cursor = start
    while cursor.seconds + 0.0005 < end {
      appendHoldFrame(black, at: cursor)
      cursor = CMTimeAdd(cursor, step)
    }
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

  /// Fills the sound track with coded silence out to `end`, for the tail at Stop and a recovery.
  ///
  /// Bounded, and that bound is load-bearing. This used to queue a buffer per 21 ms of gap with no
  /// cap at all — `maximumPendingAudio` guards the live path only — so a cursor left far behind by
  /// a failing writer turned Stop into tens of thousands of synthesised, queued and AAC-encoded
  /// buffers. On 2026-09-21 that wedged the app for the rest of the night.
  ///
  /// It writes through the same drain the live path uses, so the track has exactly one owner.
  private func appendHoldSilence(until end: CMTime) {
    guard end.isNumeric, end > .zero else { return }
    let chunk = Self.silenceChunkSeconds
    lock.lock()
    let gap = end.seconds - writtenAudioEnd
    lock.unlock()
    guard gap > chunk else { return }
    if gap > Double(Self.maximumHoldSilence) * chunk {
      telemetry.recordError(
        String(format: "program sound tail asked for %.1f s of silence, capped at %.1f s",
               gap, Double(Self.maximumHoldSilence) * chunk)
      )
    }
    // Bounded three ways, and each bound has cost a night without it: the number of chunks, the
    // appends per pass, and a wall-clock deadline for a writer that stops taking sound and never
    // starts again. `fillHold` runs synchronously inside `finish`, and `finishWithDeadline` leaves
    // work that overruns still running, so a wedge here is permanent.
    let deadline = Date().addingTimeInterval(Self.holdSilenceDeadlineSeconds)
    var remaining = Self.maximumHoldSilence
    while remaining > 0, Date() < deadline {
      let before = writtenSoundEnd()
      let passes = min(remaining, 256)
      drainAudio(limit: passes, fillUntil: end.seconds)
      let after = writtenSoundEnd()
      if after + chunk / 2 >= end.seconds { return }
      if after <= before {
        // The writer took nothing this pass: either it is not ready, or another thread holds the
        // drain. Give it a moment rather than spinning, and let the deadline end it.
        usleep(2_000)
        continue
      }
      remaining -= max(1, Int(((after - before) / chunk).rounded()))
    }
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
