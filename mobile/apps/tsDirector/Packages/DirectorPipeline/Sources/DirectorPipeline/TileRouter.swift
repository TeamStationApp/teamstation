import CoreMedia
import CoreVideo
import Foundation
import DirectorCore
import DirectorSources

/// Where archived frames go. `DirectorDVR.SegmentWriter` conforms.
/// Declaring it here keeps the dependency pointing one way: the pipeline never learns what an
/// fMP4 segment is, and the DVR never learns where frames come from.
///
/// The archive takes coded frames, not pixels: what a camera sent is what belongs on disk, so the
/// bytes go from the socket to the file without passing through a decoder or an encoder.
public protocol ArchiveSink: AnyObject, Sendable {
  func append(_ frame: CompressedFrame)
  func append(audio: CompressedAudioFrame)
}

/// Where the 1 fps proxy taps. `DirectorDVR.ProxyStore` conforms.
public protocol ProxySink: AnyObject, Sendable {
  func offer(_ frame: PixelFrame)
}

/// One source's journey from arrival to screen, archive and proxy.
///
/// The order in `handle` is the plan's first testable property: **the archive branch diverges
/// after conversion and before any UI state**. A tile in replay keeps recording live underneath
/// because the archive sink never sees `state`.
public final class SourcePipeline: @unchecked Sendable {
  public let sourceID: SourceID
  public private(set) var sourceIndex: Int
  public let renderer = TileRenderer()

  private let converter: PixelConverter
  private let telemetry: PipelineTelemetry

  private let lock = NSLock()
  /// Not a `let`: a camera that reappears at another address needs a new session, and everything
  /// else about the tile — its archive, proxy, program and audio sinks — has to survive the swap.
  private var source: FrameSource
  private var archive: ArchiveSink?
  private var proxy: ProxySink?
  private var state: TileState = .live
  /// Picture, its presentation time, and when the camera captured it (nil for replay frames).
  private var programSink: (@Sendable (CVPixelBuffer, CMTime, WallClock?) -> Void)?
  /// Fired on a programme cut, replay start, or return to live so RTMP can force an IDR.
  public var onProgramDiscontinuity: (@Sendable () -> Void)?
  private var audioSink: (@Sendable (AudioFrame) -> Void)?
  private var recordingAudioSink: (@Sendable (AudioFrame) -> Void)?
  private var replay: ReplayDecoder?
  private var lastLiveWall: WallClock?
  private var sawAudio = false
  /// Bumped when the operator starts a new scrub or returns to live, so a continuation that was
  /// assembling a playlist cannot restart tape after that session has already ended.
  private var replayEpoch: UInt64 = 0
  /// How old a picture may be and still be worth showing, and still be worth keeping. Two caps
  /// because the two consumers want different answers: the monitor is worthless showing action
  /// that has already happened, while the recording is watched afterwards, where a late picture is
  /// simply a picture and dropping it leaves a hole in the tape.
  private var latency = FrameLatencyGate()
  /// When the display gate started holding the last picture, nil while pictures are being shown.
  private var heldLateSince: WallClock?
  /// Director's own zoom on this camera's picture, 1 for none. Applied to what the tile, the
  /// programme and the scrub stills see; the camera's archive stays the picture as sent.
  private var digitalZoom: Double = 1
  public init(
    sourceID: SourceID,
    sourceIndex: Int,
    source: FrameSource,
    converter: PixelConverter,
    telemetry: PipelineTelemetry
  ) {
    self.sourceID = sourceID
    self.sourceIndex = sourceIndex
    self.source = source
    self.converter = converter
    self.telemetry = telemetry
  }

  public func setLatencyCaps(_ caps: FrameLatencyGate.Caps) {
    lock.lock()
    latency.setCaps(caps)
    lock.unlock()
  }

  public func setDigitalZoom(_ value: Double) {
    let zoom = value.isFinite ? max(value, 1) : 1
    lock.lock()
    digitalZoom = zoom
    lock.unlock()
    telemetry.mutateTile(sourceIndex) { $0.digitalZoom = zoom }
  }

  public var currentDigitalZoom: Double {
    lock.lock()
    defer { lock.unlock() }
    return digitalZoom
  }

  /// The picture with Director's zoom applied, or the picture itself when there is none (or the
  /// crop failed, which shows the whole picture rather than nothing).
  private func zoomed(_ pixelBuffer: CVPixelBuffer) -> CVPixelBuffer {
    let zoom = currentDigitalZoom
    guard zoom > 1.001 else { return pixelBuffer }
    return converter.zoom(pixelBuffer, by: zoom) ?? pixelBuffer
  }

  /// Moves this pipeline to another grid slot. Callers must also rekey `TileRouter` and telemetry.
  public func reindex(_ value: Int) {
    lock.lock()
    sourceIndex = value
    lock.unlock()
  }

  public var displayName: String { currentSource.displayName }
  public var format: SourceFormat? { currentSource.format }
  public var connections: Int { currentSource.connections }
  public var receiveStats: ReceiveStats { currentSource.receiveStats }

  private var currentSource: FrameSource {
    lock.lock()
    defer { lock.unlock() }
    return source
  }

  /// Whether this source has ever delivered an audio buffer.
  ///
  /// Not cosmetic: giving an archive an audio track that never receives a sample stalls a segmented
  /// `AVAssetWriter` at the first segment rotation, which drops every subsequent frame with no error
  /// reported anywhere. A camera may send video only, so this has to be checked rather than
  /// assumed.
  public var hasDeliveredAudio: Bool {
    lock.lock()
    defer { lock.unlock() }
    return sawAudio
  }

  public var currentState: TileState {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  /// Wall clock of the most recent live frame — the "now" edge of this source's timeline.
  public var liveEdge: WallClock? {
    lock.lock()
    defer { lock.unlock() }
    return lastLiveWall
  }

  public var sourceIsRunning: Bool { currentSource.isRunning }

  public func start() throws {
    let source = currentSource
    telemetry.mutateTile(sourceIndex) {
      $0.sourceID = sourceID.rawValue
      $0.displayName = source.displayName
      $0.state = .live
    }
    try source.start(sinks: frameSinks)
  }

  /// Swaps in a session pointed at the camera's new address, leaving the tile itself alone.
  ///
  /// The archive keeps writing to the same segments, because as far as everything downstream is
  /// concerned this is the same camera — which it is.
  public func replaceSource(_ replacement: FrameSource) throws {
    lock.lock()
    let previous = source
    source = replacement
    let isRecording = archive != nil
    lock.unlock()

    previous.stop()
    telemetry.mutateTile(sourceIndex) { $0.displayName = replacement.displayName }
    try replacement.start(sinks: frameSinks)
    // A source that has to make its own coded form only does so when told to. The one it replaces
    // was told at record start; this one arrived mid-recording and would otherwise never encode.
    replacement.setArchiving(isRecording)
  }

  private var frameSinks: FrameSinks {
    FrameSinks(
      pixel: { [weak self] frame in self?.handle(frame) },
      audio: { [weak self] frame in self?.handle(audio: frame) },
      compressed: { [weak self] frame in self?.handle(compressed: frame) },
      compressedAudio: { [weak self] frame in self?.handle(compressedAudio: frame) },
      recordingAudio: { [weak self] frame in self?.handle(recordingAudio: frame) }
    )
  }

  public var currentReplayEpoch: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return replayEpoch
  }

  /// Bump the generation and keep showing live while the first archive file is opened and
  /// decoded. Finger-up and hotkeys both use this so the rewind is not revealed until that
  /// first file has a picture; leftover lookahead is discarded if load fails.
  public func beginInstantReplayGeneration() {
    lock.lock()
    replayEpoch &+= 1
    let previous = state
    let replay = self.replay
    self.replay = nil
    state = .live
    lock.unlock()
    replay?.stop()
    if previous == .replaying {
      telemetry.recordDecodeSessionChange(delta: -1)
    }
    if previous == .scrubbing || previous == .replaying {
      renderer.prepareForLive()
    }
    telemetry.mutateTile(sourceIndex) {
      $0.state = .live
      $0.offsetSeconds = 0
    }
  }

  /// Whether this pipeline is still the camera and scrub/replay generation that captured `epoch`.
  public func isCurrentReplay(sourceID: SourceID, epoch: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return self.sourceID == sourceID && replayEpoch == epoch
  }

  public func stop() {
    lock.lock()
    replayEpoch &+= 1
    let replay = self.replay
    self.replay = nil
    let source = self.source
    lock.unlock()
    replay?.stop()
    source.stop()
    renderer.attach(layer: nil)
    telemetry.mutateTile(sourceIndex) {
      $0.state = .empty
      $0.sourceID = nil
      $0.displayName = nil
      $0.isProgram = false
      $0.packetsLost = 0
      $0.packetsLostPerSecond = 0
    }
    telemetry.resetLossRate(tile: sourceIndex)
  }

  public func setArchive(_ sink: ArchiveSink?) {
    lock.lock()
    archive = sink
    let source = self.source
    lock.unlock()
    // Tells a source that has to encode its own archive whether anyone is reading it. A source
    // that gets its coded frames for free ignores this.
    source.setArchiving(sink != nil)
  }

  /// The frame rate the camera says it is set to; see `FrameSource.setAnnouncedFrameRate`.
  public func setAnnouncedFrameRate(_ rate: Double?) {
    lock.lock()
    let source = self.source
    lock.unlock()
    source.setAnnouncedFrameRate(rate)
  }

  public func setProxy(_ sink: ProxySink?) {
    lock.lock()
    proxy = sink
    lock.unlock()
  }

  public func setProgramSink(_ sink: (@Sendable (CVPixelBuffer, CMTime, WallClock?) -> Void)?) {
    lock.lock()
    programSink = sink
    lock.unlock()
    telemetry.mutateTile(sourceIndex) { $0.isProgram = sink != nil }
  }

  public var hasProgramSink: Bool {
    lock.lock()
    defer { lock.unlock() }
    return programSink != nil
  }

  public func setAudioSink(_ sink: (@Sendable (AudioFrame) -> Void)?) {
    lock.lock()
    audioSink = sink
    lock.unlock()
  }

  /// Where this camera's sound goes for the recording's own mix: decoded as it arrives and stamped
  /// with when it was captured.
  public func setRecordingAudioSink(_ sink: (@Sendable (AudioFrame) -> Void)?) {
    lock.lock()
    recordingAudioSink = sink
    lock.unlock()
  }

  // MARK: - Frame path

  /// Backstop for a replay that stopped without telling anyone. See `ReplayWedgePolicy`.
  private let wedgePolicy = ReplayWedgePolicy()

  private func handle(_ frame: PixelFrame) {
    guard var converted = converter.convert(frame) else {
      telemetry.recordDroppedFrame(tile: sourceIndex)
      return
    }
    let zoomedBuffer = zoomed(converted.pixelBuffer)
    if zoomedBuffer !== converted.pixelBuffer {
      converted = PixelFrame(
        sourceID: converted.sourceID,
        pixelBuffer: zoomedBuffer,
        presentationTime: converted.presentationTime,
        wallClock: converted.wallClock,
        captureWallClock: converted.captureWallClock,
        frameID: converted.frameID,
        markerValue: converted.markerValue
      )
    }

    lock.lock()
    lastLiveWall = converted.wallClock
    let proxy = self.proxy
    let state = self.state
    let programSink = self.programSink
    // Judged on how old the picture was when it *arrived*: capture to arrival, not capture to
    // now. The time between the two is the delay line deliberately holding the frame to pace it,
    // which has a ceiling of its own — and judging at release counted that hold as staleness, so a
    // camera whose clock anchor is honest (NDI, age ≈ 1 ms on arrival) was refused five frames a
    // second the moment its hold reached the cap, while the phones beside it, whose RTCP anchor
    // under-reports by a few hundred milliseconds, sailed through the same gate.
    let arrived = converted.wallClock
    let showable = latency.admitsForDisplay(captured: converted.captureWallClock, now: arrived)
    let age = FrameLatencyGate.age(captured: converted.captureWallClock, now: arrived)
    if showable || state != .live {
      heldLateSince = nil
    } else if heldLateSince == nil {
      heldLateSince = arrived
    }
    let heldFor = heldLateSince.map { max(0, arrived.seconds - $0.seconds) } ?? 0
    lock.unlock()

    telemetry.recordDisplayHeldLate(tile: sourceIndex, seconds: heldFor)

    if let age { telemetry.recordFrameAge(tile: sourceIndex, milliseconds: age * 1_000) }

    telemetry.recordReceivedFrame(tile: sourceIndex, frameID: converted.frameID)

    // The proxy runs regardless of what the tile is showing, as the archive does on its own path.
    // This is what makes "scrub back while it keeps recording" true rather than aspirational.
    proxy?.offer(converted)

    // The small tile shows stills while the finger is down. Output stays on live until the
    // scrub is released, so the operator can preview rewind without cutting the programme.
    if state == .live {
      if showable {
        presentOnRenderer(converted)
      } else {
        // Held rather than shown. The last good picture stays up, which is the honest thing for a
        // monitor to do with action that has already happened.
        telemetry.recordDisplayRefusedLate(tile: sourceIndex)
      }
    }
    // The programme gets the same answer as the tile, because it is the same picture.
    //
    // This used to be decided only for the tile: a frame too old to show was still handed to the
    // compositor, so during a bad stretch the operator watched the programme move while the camera
    // tile it was cut from sat still. Whichever of the two is right, they cannot both be — and the
    // programme is the one going to air, so a picture too stale for the monitor is too stale to cut
    // to. The camera archive is unaffected either way; it is fed on arrival, before any of this.
    if state != .replaying {
      if showable {
        programSink?(converted.pixelBuffer, converted.presentationTime, converted.captureWallClock)
      }
    } else if wedgePolicy.shouldReturnToLive(
      now: Date().timeIntervalSince1970,
      lastPresentedAt: renderer.failCounts.lastEnqueueAt
    ) {
      // Measured on the live path on purpose: these frames are arriving whatever the replay is
      // doing, so they are the one heartbeat available while `.replaying` suppresses everything
      // else. A replay that is actually running keeps `lastEnqueueAt` fresh through this same
      // renderer and never reaches the timeout.
      telemetry.recordReplayWedgeRecovery(tile: sourceIndex)
      returnToLive()
    }
  }

  private func handle(audio frame: AudioFrame) {
    lock.lock()
    let audioSink = self.audioSink
    // Decoded audio proves the source has audio just as well as coded audio does, and it proves it
    // *earlier*. A source that only produces its coded form once an archive is reading — which is
    // what an NDI camera does, since encoding costs it a session — would otherwise never set this
    // before the writer is built, and would be given an archive with no audio track for the whole
    // recording.
    sawAudio = true
    lock.unlock()
    telemetry.mutateTile(sourceIndex) { $0.audioFrames &+= 1 }
    audioSink?(frame)
  }

  private func handle(recordingAudio frame: AudioFrame) {
    lock.lock()
    let sink = recordingAudioSink
    lock.unlock()
    sink?(frame)
  }

  /// The archive branch. It diverges before conversion, before the renderer and before `state`, so
  /// a tile in replay keeps recording underneath and what lands on disk is byte-for-byte what the
  /// camera sent.
  private func handle(compressed frame: CompressedFrame) {
    lock.lock()
    let archive = self.archive
    let keepable = latency.admitsForDisk(
      captured: frame.captureWallClock,
      now: frame.wallClock
    )
    lock.unlock()
    guard keepable else {
      telemetry.recordDiskRefusedLate(tile: sourceIndex)
      return
    }
    archive?.append(frame)
  }

  private func handle(compressedAudio frame: CompressedAudioFrame) {
    lock.lock()
    let archive = self.archive
    sawAudio = true
    lock.unlock()
    archive?.append(audio: frame)
  }

  // MARK: - Scrub and replay

  public func beginScrubbing() {
    lock.lock()
    replayEpoch &+= 1
    let wasReplaying = state == .replaying
    state = .scrubbing
    let replay = self.replay
    self.replay = nil
    lock.unlock()
    replay?.stop()
    if wasReplaying { telemetry.recordDecodeSessionChange(delta: -1) }
    renderer.setPaused(true)
    telemetry.mutateTile(sourceIndex) { $0.state = .scrubbing }
  }

  /// Shows a proxy still while the finger is down. The still is pushed straight into the same
  /// display layer as live video, so there is no second view to keep in sync.
  public func showScrubStill(_ pixelBuffer: CVPixelBuffer, offsetSeconds: Double) {
    renderer.setPaused(false)
    presentOnRenderer(pixelBuffer: pixelBuffer, presentationTime: .invalid)
    renderer.setPaused(true)
    telemetry.mutateTile(sourceIndex) {
      $0.state = .scrubbing
      $0.offsetSeconds = offsetSeconds
    }
  }

  public func beginReplay(
    _ decoder: ReplayDecoder,
    offsetSeconds: Double,
    stayLiveUntilFirstFrame: Bool = false
  ) async throws {
    attachReplay(decoder, offsetSeconds: offsetSeconds, reveal: !stayLiveUntilFirstFrame)
    do {
      try await decoder.start()
    } catch {
      if isAttachedReplay(decoder) {
        if stayLiveUntilFirstFrame {
          returnToLive()
        } else {
          revertToScrubbing()
        }
      }
      throw error
    }
  }

  private func isAttachedReplay(_ decoder: ReplayDecoder) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return replay === decoder
  }

  private func attachReplay(_ decoder: ReplayDecoder, offsetSeconds: Double, reveal: Bool) {
    lock.lock()
    let previous = replay
    replay = decoder
    if reveal { state = .replaying }
    lock.unlock()
    previous?.stop()

    renderer.setPaused(false)
    if reveal {
      renderer.invalidateFormatCache()
      if previous == nil { telemetry.recordDecodeSessionChange(delta: 1) }
      telemetry.mutateTile(sourceIndex) {
        $0.state = .replaying
        $0.offsetSeconds = offsetSeconds
      }
    } else if previous == nil {
      telemetry.recordDecodeSessionChange(delta: 1)
    }
  }

  /// Finger-up replay failed: keep the JPEG the drag already showed rather than snapping to live.
  public func revertToScrubbing() {
    lock.lock()
    let wasReplaying = state == .replaying
    let replay = self.replay
    self.replay = nil
    state = .scrubbing
    lock.unlock()
    replay?.stop()
    if wasReplaying { telemetry.recordDecodeSessionChange(delta: -1) }
    renderer.setPaused(true)
    telemetry.mutateTile(sourceIndex) { $0.state = .scrubbing }
  }

  /// Called by the replay decoder for each decoded frame.
  public func deliverReplayFrame(
    _ pixelBuffer: CVPixelBuffer,
    presentationTime: CMTime,
    offsetSeconds: Double
  ) {
    lock.lock()
    var promote = false
    if replay != nil, state == .live || state == .scrubbing {
      state = .replaying
      promote = true
    }
    let state = self.state
    let epoch = replayEpoch
    let programSink = self.programSink
    lock.unlock()
    guard state == .replaying else { return }
    if promote {
      renderer.invalidateFormatCache()
      onProgramDiscontinuity?()
    }

    let picture = zoomed(pixelBuffer)
    presentOnRenderer(pixelBuffer: picture, presentationTime: presentationTime)
    programSink?(picture, presentationTime, nil)
    // Only for the replay that delivered this frame, and under the lock. A return to live that
    // lands while the frame is being presented has already put the tile back on live; written
    // after it, this left the tile saying "replaying" for good -- the picture live, the tile still
    // offering Return to Live, and the programme still marked as a replay -- with nothing left
    // running to clear it.
    lock.lock()
    defer { lock.unlock() }
    guard replayEpoch == epoch, self.state == .replaying else { return }
    telemetry.mutateTile(sourceIndex) { tile in
      guard tile.state == .replaying || tile.state == .live else { return }
      tile.state = .replaying
      tile.offsetSeconds = offsetSeconds
    }
  }

  public func returnToLive() {
    lock.lock()
    replayEpoch &+= 1
    let wasReplaying = state == .replaying
    let replay = self.replay
    self.replay = nil
    state = .live
    lock.unlock()

    replay?.stop()
    if wasReplaying { telemetry.recordDecodeSessionChange(delta: -1) }
    if wasReplaying { onProgramDiscontinuity?() }
    renderer.prepareForLive()
    telemetry.mutateTile(sourceIndex) {
      $0.state = .live
      $0.offsetSeconds = 0
    }
  }

  private func presentOnRenderer(_ frame: PixelFrame) {
    presentOnRenderer(pixelBuffer: frame.pixelBuffer, presentationTime: frame.presentationTime)
  }

  private func presentOnRenderer(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
    let ok = renderer.enqueue(pixelBuffer: pixelBuffer, presentationTime: presentationTime)
    telemetry.mutateTile(sourceIndex) { $0.enqueueFails = renderer.failCounts }
    if ok {
      telemetry.recordDisplayedFrame(tile: sourceIndex)
    }
  }
}

/// Owns every active source pipeline, the exactly-one-program invariant, and the program
/// output chain.
public final class TileRouter: @unchecked Sendable {
  private let telemetry: PipelineTelemetry
  private let converter: PixelConverter
  private let compositor: MetalCompositor?
  private let programEncoder: ProgramEncoder
  private let programStreamer: ProgramStreamer

  /// Display layer for the programme preview tile, fed the composited frame.
  public let programRenderer = TileRenderer()
  /// Each contributing camera's sound, laid down by capture time the moment it is decoded and read
  /// by both mixes.
  public let soundTimelines: SourceSoundTimelines
  /// The live mix: what the stream and the speakers play, each camera's sound `liveSoundDelay`
  /// after it was captured.
  public let audioMixer: AudioMixer
  /// The recording's own mix, which feeds only the programme master.
  ///
  /// The live mix hears each camera D after capture (a second by default), and sound later than that is
  /// silence on the stream and the speakers: take 365's programme went quiet for 2.7–4.2 s of every
  /// 4 s while the Pixel's sound came in clumps, though the Pixel's own file kept it. The recording
  /// is watched afterwards, so its mix reads sound at its capture time and waits
  /// `recordingMixDelaySeconds` for it. It reads the same timelines, not a second copy.
  public let recordingMixer: AudioMixer
  /// How long the recording's mix waits for a camera's sound. Five seconds covers the 4 s clumps and
  /// 2.5 s lateness the stress run gives the Pixel's sound. The programme's writer takes sound this
  /// far behind its picture without refusing either: measured with its fragmented MP4 on
  /// 2026-09-15, 0 of 720 pictures and 0 of 600 sound buffers refused at 4 s and at 6 s. A movie
  /// fragment closes only once every track has reached it, so the master's fragments close this
  /// much later, and a crash can cost this much more than the three-second fragment it did.
  public static let recordingMixDelaySeconds: Double = 5
  public let audioPlayer: ProgramAudioPlayer
  public let waveformMonitor = AudioWaveformMonitor()

  private let lock = NSLock()
  private var pipelines: [Int: SourcePipeline] = [:]
  private var programSource: Int?
  /// Cameras whose PCM is summed into the programme mix. Every live pipeline still taps audio so
  /// the waveform can draw when AUDIO is off.
  private var mixContributorIDs: Set<SourceID> = []
  /// Streaming or recording is on, so both mixes keep counting with no camera at all: their sound
  /// tracks run from go-live, and a camera removed and added back must not restart the counter.
  private var programmeSoundHeld = false
  /// Held so a camera enabled later inherits the caps rather than starting ungated.
  private var latencyCaps = FrameLatencyGate.Caps()
  public let clock: DirectorClock

  /// The programme's own frame clock; see `ProgrammeClock`. Ticks on `programmeQueue`.
  private var programmeClock = ProgrammeClock(recordingRate: 30, streamRate: 30)
  private var recordingRate = 30
  private var streamRate = 30
  private var programmeTimer: DispatchSourceTimer?
  private let programmeQueue = DispatchQueue(
    label: "app.teamstation.director.programme-clock",
    qos: .userInteractive
  )
  /// A composited programme picture, waiting for the programme clock.
  private struct ProgramPicture {
    let buffer: CVPixelBuffer
    /// When the picture on air was captured; nil for a replay.
    let captureWall: WallClock?
  }
  /// Composited pictures of the camera on air, each taken on the tick its capture time plus the
  /// live delay D comes due: the same moment its sound plays. See `ProgrammePictureQueue`.
  private var programPictures = ProgrammePictureQueue<ProgramPicture>(
    delaySeconds: AudioMixer.defaultLiveReadLagSeconds
  )
  /// The programme clock's worst lateness since `programmeTickStatistics` was last read, and the
  /// ticks it has missed, for the take's telemetry.
  private var tickLatenessMax: Double = 0
  private var missedTicks: UInt64 = 0
  /// The picture the recording last took, so a repeat can be told from a new one.
  private var lastRecordedSequence: UInt64?
  /// Programme pictures left out because the compositor could not make one.
  private var composeMisses: UInt64 = 0

  public init(
    telemetry: PipelineTelemetry,
    converter: PixelConverter,
    compositor: MetalCompositor?,
    programEncoder: ProgramEncoder,
    programStreamer: ProgramStreamer,
    clock: DirectorClock
  ) {
    self.telemetry = telemetry
    self.converter = converter
    self.clock = clock
    self.compositor = compositor
    self.programEncoder = programEncoder
    self.programStreamer = programStreamer
    let audioPlayer = ProgramAudioPlayer()
    self.audioPlayer = audioPlayer
    let timelines = SourceSoundTimelines(clock: clock)
    soundTimelines = timelines
    self.audioMixer = AudioMixer(
      clock: clock,
      readLagSeconds: AudioMixer.defaultLiveReadLagSeconds,
      timelines: timelines
    ) { [programStreamer, audioPlayer] frame in
      programStreamer.append(audio: frame)
      audioPlayer.schedule(frame)
    }
    self.recordingMixer = AudioMixer(
      clock: clock,
      delaySeconds: Self.recordingMixDelaySeconds,
      windowSeconds: Self.recordingMixDelaySeconds + 5,
      timelines: timelines
    ) { [programEncoder] frame in
      programEncoder.append(audio: frame)
    }
    restartProgrammeClock()
  }

  deinit {
    programmeTimer?.cancel()
  }

  // MARK: - The programme clock

  /// The programme master's frame rate, from the take being recorded.
  public func setRecordingRate(_ rate: Int) {
    lock.lock()
    recordingRate = max(1, rate)
    lock.unlock()
    restartProgrammeClock()
  }

  /// The stream's frame rate, from the stream settings.
  public func setStreamRate(_ rate: Int) {
    lock.lock()
    streamRate = max(1, rate)
    lock.unlock()
    restartProgrammeClock()
  }

  private func restartProgrammeClock() {
    lock.lock()
    programmeClock = ProgrammeClock(recordingRate: recordingRate, streamRate: streamRate)
    let rate = programmeClock.rate
    programmeTimer?.cancel()
    let period = DispatchTimeInterval.nanoseconds(Int(1_000_000_000 / Double(rate)))
    let timer = DispatchSource.makeTimerSource(queue: programmeQueue)
    timer.schedule(deadline: .now() + period, repeating: period, leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in self?.programmeTick() }
    programmeTimer = timer
    lock.unlock()
    timer.resume()
  }

  /// One tick of the programme clock: the newest picture goes to the recording when a recording
  /// frame falls on this tick, and to the stream on every tick, each stamped with the clock's own
  /// time. With nothing new since the last tick, the last picture goes again.
  private func programmeTick() {
    let now = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    let wallNow = clock.now.seconds
    lock.lock()
    guard let tick = programmeClock.tick(at: now) else {
      lock.unlock()
      return
    }
    tickLatenessMax = max(tickLatenessMax, tick.lateness)
    missedTicks &+= UInt64(max(0, tick.ticksMissed))
    guard let entry = programPictures.pick(at: wallNow, period: 1 / Double(programmeClock.rate)) else {
      lock.unlock()
      return
    }
    let picture = entry.picture
    let streamRate = programmeClock.streamRate
    let recordingRate = programmeClock.recordingRate
    var freshForRecording = false
    if tick.recordingFrame != nil {
      freshForRecording = entry.sequence != lastRecordedSequence
      lastRecordedSequence = entry.sequence
    }
    lock.unlock()

    if let frame = tick.recordingFrame, programEncoder.running {
      // The recording is written on an exact grid, so frames a late timer skipped are written as
      // repeats of the newest picture rather than left as one frame lasting several: up to a
      // quarter-second of them. A longer stall of the clock itself is left to the encoder, which
      // keeps the timeline on real time across it.
      let missed = min(tick.recordingFramesMissed, Int64(max(1, recordingRate / 4)))
      for skipped in stride(from: frame - missed, to: frame, by: 1) {
        programEncoder.append(
          picture.buffer,
          presentationTime: CMTime(value: skipped, timescale: CMTimeScale(recordingRate)),
          captureWall: nil,
          onClockGrid: true
        )
      }
      // A repeat carries no capture time, so the encoder's anchors borrow the delay it last measured
      // rather than reading a stall as the programme slipping further and further behind.
      programEncoder.append(
        picture.buffer,
        presentationTime: CMTime(value: frame, timescale: CMTimeScale(recordingRate)),
        captureWall: freshForRecording ? picture.captureWall : nil,
        onClockGrid: true
      )
    }
    if let frame = tick.streamFrame, programStreamer.running {
      programStreamer.append(
        picture.buffer,
        presentationTime: CMTime(value: frame, timescale: CMTimeScale(streamRate))
      )
    }
  }

  public var activePipelines: [SourcePipeline] {
    lock.lock()
    defer { lock.unlock() }
    return pipelines.values.sorted { $0.sourceIndex < $1.sourceIndex }
  }

  public func pipeline(at sourceIndex: Int) -> SourcePipeline? {
    lock.lock()
    defer { lock.unlock() }
    return pipelines[sourceIndex]
  }

  public func pipeline(for sourceID: SourceID) -> SourcePipeline? {
    lock.lock()
    defer { lock.unlock() }
    return pipelines.values.first { $0.sourceID == sourceID }
  }

  /// Swaps two occupied slots, or moves one pipeline onto an empty slot. Output follows the slot.
  /// Return both sources to live before calling if either is replaying.
  public func reassign(from: Int, to: Int) {
    guard from != to else { return }
    lock.lock()
    let moving = pipelines[from]
    let occupant = pipelines[to]
    if moving == nil && occupant == nil {
      lock.unlock()
      return
    }
    moving?.reindex(to)
    occupant?.reindex(from)
    pipelines[from] = occupant
    pipelines[to] = moving
    if programSource == from {
      programSource = to
    } else if programSource == to {
      programSource = from
    }
    let selected = programSource
    lock.unlock()
    telemetry.swapSlots(from, to)
    selectProgram(sourceIndex: selected)
  }

  /// Repoints one tile's camera at a new session. Nothing else about the grid changes: the tile
  /// keeps its index, its program status and its archive.
  public func replaceSource(_ replacement: FrameSource, for sourceID: SourceID) throws {
    guard let pipeline = pipeline(for: sourceID) else { return }
    try pipeline.replaceSource(replacement)
  }

  /// The display and disk latency caps, applied to every camera and remembered for the next one.
  public func setLatencyCaps(_ caps: FrameLatencyGate.Caps) {
    lock.lock()
    latencyCaps = caps
    let all = Array(pipelines.values)
    lock.unlock()
    for pipeline in all { pipeline.setLatencyCaps(caps) }
  }

  public func add(_ pipeline: SourcePipeline) {
    lock.lock()
    pipelines[pipeline.sourceIndex] = pipeline
    let selected = programSource
    let caps = latencyCaps
    lock.unlock()
    pipeline.setLatencyCaps(caps)
    // Output can be chosen before this camera's pipeline exists (the first enable, or a
    // persisted cut restored at launch). Rebind so frames actually reach the programme tile.
    if selected == pipeline.sourceIndex {
      selectProgram(sourceIndex: selected)
    }
  }

  public func removeAll() {
    lock.lock()
    let existing = Array(pipelines.values)
    pipelines.removeAll()
    programSource = nil
    lock.unlock()
    for pipeline in existing {
      waveformMonitor.remove(source: pipeline.sourceID)
      pipeline.stop()
    }
    lock.lock()
    let held = programmeSoundHeld
    lock.unlock()
    soundTimelines.removeAll()
    if !held {
      audioMixer.stop()
      recordingMixer.stop()
    }
    audioPlayer.stop()
    // Output's TileVideoView stays on screen — the grid is always the root. Detaching its
    // layer here freezes the last frame: SwiftUI will not call updateUIView because
    // `programRenderer` is the same object, and later cuts enqueue into nowhere.
    programRenderer.prepareForLive()
    telemetry.mutate { $0.programSource = nil }
  }

  /// Holds both mixes running while the programme is live (streaming or recording), and starts them
  /// if no camera has yet. Their counters start at go-live at the latest, so the stream and the
  /// master carry sound — silence until a camera speaks — from their first picture. Released with
  /// no camera left, the mixes stop.
  public func setProgrammeSoundLive(_ live: Bool) {
    lock.lock()
    programmeSoundHeld = live
    let empty = pipelines.isEmpty
    lock.unlock()
    if live {
      audioMixer.start()
      recordingMixer.start()
    } else if empty {
      audioMixer.stop()
      recordingMixer.stop()
    }
  }

  /// Stops one tile without touching the others. Opening the camera list must not rebuild the grid.
  public func remove(sourceIndex: Int) {
    lock.lock()
    let pipeline = pipelines.removeValue(forKey: sourceIndex)
    let wasProgram = programSource == sourceIndex
    if wasProgram { programSource = nil }
    let remaining = pipelines.values.sorted { $0.sourceIndex < $1.sourceIndex }
    lock.unlock()
    if let pipeline {
      waveformMonitor.remove(source: pipeline.sourceID)
      pipeline.stop()
      // A camera added back is a new source object counting its sessions from one again.
      soundTimelines.existing(pipeline.sourceID)?.reset()
    }
    lock.lock()
    let held = programmeSoundHeld
    lock.unlock()
    if remaining.isEmpty, !held {
      audioMixer.stop()
      recordingMixer.stop()
    }
    if wasProgram {
      selectProgram(sourceIndex: remaining.first?.sourceIndex)
    }
  }

  public var currentProgramSource: Int? {
    lock.lock()
    defer { lock.unlock() }
    return programSource
  }

  /// The exactly-one-program invariant lives here rather than in the view, so it holds even
  /// when program is changed over the control channel.
  public func selectProgram(sourceIndex: Int?) {
    lock.lock()
    let previous = programSource
    programSource = sourceIndex
    let all = pipelines
    lock.unlock()

    // Audio is no longer tied to whichever tile is on program — it comes from every source the
    // operator ticked, mixed together — so cutting the picture leaves the sound alone.
    for (index, pipeline) in all {
      if index == sourceIndex {
        pipeline.onProgramDiscontinuity = { [weak self] in
          self?.programStreamer.requestKeyframe()
        }
        pipeline.setProgramSink { [weak self] buffer, time, capture in
          self?.composeAndEncode(buffer, presentationTime: time, captureWall: capture)
        }
      } else {
        pipeline.onProgramDiscontinuity = nil
        pipeline.setProgramSink(nil)
      }
    }
    if previous != sourceIndex {
      // The old camera's pictures still waiting for their moment are not wanted after a cut.
      lock.lock()
      programPictures.removeQueued()
      lock.unlock()
      programStreamer.requestKeyframe()
    }
    telemetry.mutate { snapshot in
      snapshot.programSource = sourceIndex
      for index in snapshot.tiles.indices {
        snapshot.tiles[index].isProgram = snapshot.tiles[index].index == sourceIndex
      }
    }
  }

  /// Points the named sources at the programme mix. Every live pipeline still taps PCM so the
  /// cameras-list oscilloscope can draw native audio even when AUDIO is off.
  public func setAudioContributors(_ ids: Set<SourceID>) {
    lock.lock()
    mixContributorIDs = ids
    let all = Array(pipelines.values)
    lock.unlock()

    for pipeline in all {
      let contributes = ids.contains(pipeline.sourceID)
      pipeline.setAudioSink { [weak self] frame in self?.handleTappedAudio(frame) }
      pipeline.setRecordingAudioSink { [weak self] frame in self?.handleSound(frame) }
      telemetry.mutateTile(pipeline.sourceIndex) { $0.contributesAudio = contributes }
    }
    soundTimelines.retain(ids)
    audioMixer.setContributors(ids)
    recordingMixer.setContributors(ids)
  }

  /// How long after capture the live mix plays each camera's sound: the display latency cap, the
  /// same delay the pictures are held to. A change fades every source out and in again.
  public func setLiveSoundDelay(seconds: Double) {
    audioMixer.setReadLag(seconds: seconds)
    lock.lock()
    programPictures.setDelay(seconds: seconds)
    lock.unlock()
  }

  /// The programme clock's worst lateness since the last read, in seconds, which this read resets,
  /// and the ticks it has missed in all.
  public func programmeTickStatistics() -> (latenessMax: Double, missed: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    let result = (tickLatenessMax, missedTicks)
    tickLatenessMax = 0
    return result
  }

  /// Programme pictures dropped for arriving more than a tick after their moment, and pictures
  /// never shown because a newer one was due on the same tick.
  public var programmePictureCounts: (late: UInt64, skipped: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    return (programPictures.latePictures, programPictures.skippedPictures)
  }

  /// Programme pictures left out because the compositor could not make one; the last repeated.
  public var programmeComposeMisses: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return composeMisses
  }

  /// The live sound delay for a display latency cap: the cap itself when it is on, 1 s when it
  /// is off, and never under 100 ms or over 2 s, the delay line's own ceiling.
  public static func liveSoundDelaySeconds(capEnabled: Bool, capMilliseconds: Double) -> Double {
    let milliseconds = capEnabled && capMilliseconds > 0
      ? capMilliseconds
      : AudioMixer.defaultLiveReadLagSeconds * 1_000
    return min(2, max(0.1, milliseconds / 1_000))
  }

  /// The most any camera's delay line may hold: the live delay D, cap on or off. Programme pictures
  /// are placed at capture + D and reach the queue only after the preview's delay line, so a line
  /// holding more than D delivers every picture after its moment and the programme freezes on its
  /// last one. With the cap off the line could grow, and a saved hold be seeded, to 2 s.
  public static func playoutCapMilliseconds(capEnabled: Bool, capMilliseconds: Double) -> Double {
    liveSoundDelaySeconds(capEnabled: capEnabled, capMilliseconds: capMilliseconds) * 1_000
  }

  /// Per-camera constants added to each camera's capture times, for a camera whose sound is stamped
  /// early or late by a known amount.
  public func setSoundTrims(_ trims: [SourceID: Double]) {
    soundTimelines.setTrims(trims)
  }

  /// Each contributing camera's sound as the two mixes see it, keyed by tile index.
  public func soundStatus() -> [Int: SourceSoundStatus] {
    lock.lock()
    let all = pipelines
    let contributing = mixContributorIDs
    lock.unlock()
    let liveLag = audioMixer.currentStatistics.readLagSeconds
    var result: [Int: SourceSoundStatus] = [:]
    for (index, pipeline) in all where contributing.contains(pipeline.sourceID) {
      guard let timeline = soundTimelines.existing(pipeline.sourceID) else { continue }
      let reader = audioMixer.reader(for: pipeline.sourceID)
      let readHead = Int64((HostUptime.seconds() - AudioMixer.mixDelaySeconds - liveLag) * AudioMixer.sampleRate)
      result[index] = SourceSoundStatus(
        timeline: timeline.currentStatistics,
        live: reader,
        heldSeconds: timeline.secondsHeld(after: readHead) ?? 0
      )
    }
    return result
  }

  /// Director's zoom per camera; a camera not named goes back to 1.
  public func setDigitalZooms(_ zooms: [SourceID: Double]) {
    lock.lock()
    let all = Array(pipelines.values)
    lock.unlock()
    for pipeline in all {
      pipeline.setDigitalZoom(zooms[pipeline.sourceID] ?? 1)
    }
  }

  public func setInputGains(_ gains: [SourceID: Double]) {
    audioMixer.setInputGains(gains)
    recordingMixer.setInputGains(gains)
  }

  /// A contributing camera's sound, at its capture time, onto its timeline. Called on the source's
  /// receive thread as soon as the sound is decoded, so nothing the iPad does with pictures can hold
  /// it up.
  private func handleSound(_ frame: AudioFrame) {
    lock.lock()
    let contributes = mixContributorIDs.contains(frame.sourceID)
    lock.unlock()
    guard contributes else { return }
    soundTimelines.append(frame)
  }

  /// Every camera's sound, mixed or not, for the cameras list's oscilloscope.
  private func handleTappedAudio(_ frame: AudioFrame) {
    waveformMonitor.append(source: frame.sourceID, sampleBuffer: frame.sampleBuffer)
  }

  /// Composites a programme picture as it arrives, shows it on the preview tile, and leaves it for
  /// the programme clock to encode.
  ///
  /// The compositing happens whether or not anything is recording, which is the point of the
  /// preview: the operator has to be able to see overlays sitting over the picture before
  /// committing it to a file, not discover afterwards that it was mispositioned. The recording and
  /// the stream take their frames on the programme clock instead of here, so a camera's delivery —
  /// bursts, stalls, a frozen feed — never sets their timing.
  private func composeAndEncode(
    _ pixelBuffer: CVPixelBuffer,
    presentationTime: CMTime,
    captureWall: WallClock? = nil
  ) {
    // With a compositor, only a composed picture goes on air: one without its overlays, from a
    // compositor that could not make a picture just then, flickers the overlay off. The last
    // composed picture repeats instead, which no one sees.
    let composed: CVPixelBuffer
    if let compositor {
      guard let made = compositor.compose(program: pixelBuffer) else {
        lock.lock()
        composeMisses &+= 1
        lock.unlock()
        return
      }
      composed = made
    } else {
      composed = pixelBuffer
    }
    programRenderer.enqueue(pixelBuffer: composed, presentationTime: presentationTime)
    lock.lock()
    programPictures.add(
      ProgramPicture(buffer: composed, captureWall: captureWall),
      capture: captureWall?.seconds
    )
    lock.unlock()
  }
}

/// One camera's sound as `TileRouter.soundStatus` reports it.
public struct SourceSoundStatus: Sendable {
  public let timeline: SourceSoundTimeline.Statistics
  /// The live mix's reader, nil before it has read this camera.
  public let live: SourceSoundTimeline.Reader?
  /// Sound waiting ahead of the live mix's read head.
  public let heldSeconds: Double
}
