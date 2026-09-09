import CoreMedia
import CoreVideo
import Foundation
import DirectorCore
import DirectorSources

/// Receives one camera over RTSP and republishes it as `PixelFrame`s and `AudioFrame`s.
///
/// Everything above `FrameSource` — the DVR, scrub, compositor, programme encode and export — is
/// unchanged by this existing: it never learns that a frame arrived as RTP.
///
/// Reconnection is this class's job and is genuinely new work. An RTSP session does not heal
/// itself: when a camera reboots or its lease changes, the socket either dies or goes quiet, and
/// without supervision the tile stays black for the rest of the game.
public final class RTSPFrameSource: FrameSource, StreamIdentityReporting, @unchecked Sendable {
  /// Called when reconnecting to the same address has repeatedly failed, so the camera has probably
  /// moved and its identity needs re-resolving against a fresh scan.
  public typealias RelocationHandler = @Sendable (SourceID) -> Void

  public let sourceID: SourceID
  public let displayName: String
  public var onStreamAdvertisement: (@Sendable (StreamAdvertisement) -> Void)? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return streamAdvertisementHandler
    }
    set {
      lock.lock()
      streamAdvertisementHandler = newValue
      lock.unlock()
    }
  }

  private let configuration: RTSPSession.Configuration
  private let clock: DirectorClock
  private let onNeedsRelocation: RelocationHandler?
  private let coordinator: PlayoutCoordinator?

  /// No completed picture for this long means the session is dead even though the socket is open —
  /// the failure a camera on a flapping link actually produces.
  private static let stallTimeout: TimeInterval = 5
  private static let backoffSeconds: [TimeInterval] = [ 1, 2, 4, 8 ]
  /// After this many failures the address itself is suspect rather than the connection.
  private static let attemptsBeforeRelocation = 3
  /// How often the delay line is checked for frames that have come due. Finer than a display
  /// refresh on a 120 Hz iPad, so releasing on this tick never adds a visible interval of its own.
  private static let drainInterval: TimeInterval = 0.004
  /// How often this camera's measured requirement is published to its neighbours.
  private static let reportInterval: TimeInterval = 1
  /// How far ahead of its due time a picture is decoded.
  ///
  /// An IDR frame takes an order of magnitude longer to decode than the frames between them — 30 ms
  /// against 3 ms on an M4 — and doing that work at the moment the frame is due delays the next
  /// release by as much, which is a visible hitch of its own. Decoding early and holding the pixel
  /// buffer for the remainder costs two frames of memory and takes the decode off the clock.
  private static let decodeLead: TimeInterval = 0.06
  /// How much video the compressed delay line may hold, in seconds.
  ///
  /// `PlayoutQueue` bounds a count rather than a duration, so this is turned into frames against
  /// the measured rate. It has to be: a fixed cap was three seconds at 30 fps and only a second
  /// and a half at 60, which is less than the two seconds `PlayoutController.Limits` allows the
  /// buffer to grow to. Overflowing costs more than it sounds — the queue is ordered by due time
  /// and trims from the front, so the pictures it discards are the ones about to be shown.
  private static let pictureQueueSeconds: Double = 3
  /// The rate assumed for the dozen frames before `frameRateEstimator` has an answer, and after a
  /// reconnect if this camera has never reported a format. The faster of the two rates in the
  /// population, because both consumers fail worse when the guess is low: the delay line drops
  /// frames it was about to show, and replay runs at half speed.
  private static let assumedFrameRate: Double = 60

  private let lock = NSLock()
  private let queue: DispatchQueue
  private var session: RTSPSession?
  private var sinks = FrameSinks()
  private var running = false

  private var videoDepacketizer: VideoDepacketizer?
  private var videoTracker = RTPSequenceTracker()
  private var audioTracker = RTPSequenceTracker()
  private var decoder: VideoToolboxDecoder?
  private var audioDecoder: AACAudioDecoder?
  private var audioDepacketizer: AACDepacketizer?
  private var audioFormatDescription: CMAudioFormatDescription?
  private var channels = RTSPSession.Channels(video: 0, audio: nil)

  /// What the archive needs to describe this camera's tracks, which is separate from what the
  /// decoder needs to decode them: the writer builds its own format descriptions from these.
  private var videoCodec: VideoCodec?
  private var videoParameterSets: [Data] = []
  private var audioConfig: (cookie: Data, sampleRate: Double, channels: Int)?

  private var frameID: UInt64 = 0
  private var videoTimeline = RTPTimestampUnwrapper()
  /// What the camera's own sender reports say about its clock. Measurement only: nothing here
  /// feeds playout yet.
  private var clockAudit = RTPClockAudit()
  /// Most recent frame's capture time on our clock, and how far behind now that is. The age is
  /// excess over this camera's own best case rather than absolute delay — see `ReceiveStats`.
  private var lastCorrectedCapture: Double = 0
  /// SSRC of the stream this source's pictures come from, so the clock anchor is taken from the
  /// same stream rather than whichever has moved the most bytes so far.
  private var videoSSRC: UInt32?
  private var correctedCaptureAgeSeconds: Double = 0
  private var audioTimeline = RTPTimestampUnwrapper()
  private var lastPresentationTime: CMTime?
  private var lastAccessUnitAt: Date?
  private var sessionStartedAt: Date?
  private var resolvedFormat: SourceFormat?
  /// What this camera is actually sending, measured from its own RTP timestamps. Nothing in RTSP
  /// states it, and replay pacing depends on it.
  private var frameRateEstimator = FrameRateEstimator()
  private var connectionCount = 0
  private var stats = ReceiveStats()
  private var failedAttempts = 0
  private var lastFailure: String?
  private var stallTimer: DispatchSourceTimer?
  private var reconnectItem: DispatchWorkItem?
  private var pendingWaitStart: DispatchTime?
  private var streamAdvertisementHandler: (@Sendable (StreamAdvertisement) -> Void)?
  private var jitter = JitterWindow()

  private var playout: PlayoutController
  private var pictures = PlayoutQueue<PendingPicture>()
  private var decodedFrames = PlayoutQueue<PixelFrame>()
  private var audioFrames = PlayoutQueue<AudioFrame>()
  private var drainTimer: DispatchSourceTimer?
  private var lastReportAt: Double = 0

  /// A coded picture waiting for its moment. Decoding happens on release, so what is held is the
  /// handful of kilobytes it arrived as rather than a three-megabyte pixel buffer.
  private struct PendingPicture: Sendable {
    let unit: VideoAccessUnit
    let presentationTime: CMTime
  }

  /// Frame identities handed out at arrival and claimed at decode, so the copy on disk and the
  /// picture on screen agree on which frame they are — the audit R4 rests on.
  private var pendingFrameIDs: [CMTimeValue: UInt64] = [:]

  public init(
    sourceID: SourceID,
    displayName: String,
    configuration: RTSPSession.Configuration,
    clock: DirectorClock = SystemClock(),
    coordinator: PlayoutCoordinator? = nil,
    onNeedsRelocation: RelocationHandler? = nil
  ) {
    self.sourceID = sourceID
    self.displayName = displayName
    self.configuration = configuration
    self.clock = clock
    self.coordinator = coordinator
    self.onNeedsRelocation = onNeedsRelocation
    playout = PlayoutController(
      seedMilliseconds: coordinator?.seedMilliseconds(for: sourceID) ?? Self.defaultSeedMilliseconds
    )
    queue = DispatchQueue(label: "co.gamestation.director.rtsp-source.\(sourceID.slug)")
  }

  /// What a camera nobody has measured yet starts at. From the three VM33s on the bench, whose
  /// keyframe bursts want 232–277 ms in a typical window; a camera that needs more gets there
  /// within a few seconds of streaming.
  public static let defaultSeedMilliseconds: Double = 300

  // MARK: - FrameSource

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  public var format: SourceFormat? {
    lock.lock()
    defer { lock.unlock() }
    return resolvedFormat
  }

  public var connections: Int {
    lock.lock()
    defer { lock.unlock() }
    return connectionCount
  }

  /// Why the last session ended, for the HUD. A tile that is black for a knowable reason should
  /// say so rather than leaving the operator to guess between network, camera and app.
  public var lastFailureReason: String? {
    lock.lock()
    defer { lock.unlock() }
    return lastFailure
  }

  public var receiveStats: ReceiveStats {
    lock.lock()
    defer { lock.unlock() }
    var snapshot = stats
    snapshot.packetsLost = videoTracker.lost &+ audioTracker.lost
    snapshot.status = lastFailure
    snapshot.arrivalGapMaxMilliseconds = (jitter.gapMaxMilliseconds * 10).rounded() / 10
    snapshot.arrivalGapWasKeyframe = jitter.gapWasKeyframe
    snapshot.releaseGapMaxMilliseconds = (jitter.releaseGapMaxMilliseconds * 10).rounded() / 10
    snapshot.deliverMaxMilliseconds = (jitter.deliverMaxMilliseconds * 10).rounded() / 10
    snapshot.pacingSpreadMilliseconds = (jitter.latenessSpreadMilliseconds * 10).rounded() / 10
    snapshot.playoutMilliseconds = (playout.bufferMilliseconds * 10).rounded() / 10
    snapshot.playoutLateFrames = playout.lateFrames
    snapshot.stalledForSeconds = running
      ? StallWatchdog.stalledForSeconds(
        now: Date(),
        lastAccessUnitAt: lastAccessUnitAt,
        sessionStartedAt: sessionStartedAt,
        timeout: Self.stallTimeout
      )
      : 0
    snapshot.playoutDepth = pictures.count + decodedFrames.count
    snapshot.senderReports = clockAudit.reportCount
    snapshot.senderReportIntervalSeconds = (clockAudit.meanIntervalSeconds * 100).rounded() / 100
    snapshot.senderReportAgeSeconds = clockAudit.lastReportUptime > 0
      ? ((Self.seconds(DispatchTime.now()) - clockAudit.lastReportUptime) * 10).rounded() / 10
      : 0
    snapshot.mediaTicksPerSecond = (clockAudit.ticksPerSecond * 100).rounded() / 100
    snapshot.mediaClockSpanSeconds = (clockAudit.measuredSpanSeconds * 10).rounded() / 10
    snapshot.cameraClockOffsetSeconds = (clockAudit.ntpOffsetSeconds * 1000).rounded() / 1000
    snapshot.cameraClockOffsetFilteredSeconds = (clockAudit.filteredOffsetSeconds * 1000).rounded() / 1000
    snapshot.cameraClockOffsetSamples = clockAudit.offsetSampleCount
    snapshot.correctedCaptureTime = lastCorrectedCapture
    snapshot.correctedCaptureAgeMilliseconds = (correctedCaptureAgeSeconds * 1000).rounded()
    snapshot.senderReportStreams = clockAudit.streamCount
    if let decoder {
      let decoderStats = decoder.currentStatistics
      snapshot.formatMisses &+= decoderStats.failures &+ decoderStats.droppedCorrupt
      snapshot.decodeSessions = 1
    }
    return snapshot
  }

  public func start(sinks: FrameSinks) throws {
    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    running = true
    self.sinks = sinks
    failedAttempts = 0
    lock.unlock()

    connect()
    startStallWatchdog()
    startDrain()
  }

  public func stop() {
    lock.lock()
    running = false
    let session = self.session
    self.session = nil
    stallTimer?.cancel()
    stallTimer = nil
    drainTimer?.cancel()
    drainTimer = nil
    reconnectItem?.cancel()
    reconnectItem = nil
    let decoder = self.decoder
    self.decoder = nil
    audioDecoder = nil
    connectionCount = 0
    pictures.removeAll()
    decodedFrames.removeAll()
    audioFrames.removeAll()
    lock.unlock()

    coordinator?.retire(sourceID)

    session?.stop()
    decoder?.invalidate()
  }

  // MARK: - Session lifecycle

  private func connect() {
    let session = RTSPSession(configuration: configuration) { [weak self] event in
      self?.handle(event)
    }

    lock.lock()
    guard running else {
      lock.unlock()
      return
    }
    self.session = session
    parserStateReset()
    pendingWaitStart = .now()
    sessionStartedAt = Date()
    lock.unlock()

    session.start()
  }

  /// Everything derived from one session's SDP. A reconnect may find a camera that has changed
  /// codec or resolution, so none of it may be carried across.
  private func parserStateReset() {
    videoDepacketizer = nil
    audioDepacketizer = nil
    audioFormatDescription = nil
    videoCodec = nil
    videoParameterSets = []
    audioConfig = nil
    pendingFrameIDs.removeAll()
    videoTracker = RTPSequenceTracker()
    audioTracker = RTPSequenceTracker()
    videoTimeline.reset()
    clockAudit.reset()
    audioTimeline.reset()
    lastPresentationTime = nil
    // A new session means a new anchor, so a corrected capture time from the old one describes a
    // clock that no longer applies. Leaving it set stamped every frame after a reconnect with a
    // pre-outage moment.
    lastCorrectedCapture = 0
    correctedCaptureAgeSeconds = 0
    videoSSRC = nil
    jitter = JitterWindow()
    frameRateEstimator.reset()
    // A new session restarts the timeline, so every frame held against the old one is stale and
    // every measurement taken against it is meaningless. What the camera converged on is not: it
    // carries over as the starting size.
    pictures.removeAll()
    decodedFrames.removeAll()
    audioFrames.removeAll()
    playout = playout.reset()
  }

  private func handle(_ event: RTSPSession.Event) {
    switch event {
    case let .playing(description, channels):
      configure(with: description, channels: channels)
      publishAdvertisement(cname: description.streamCNAME, name: description.streamName)

    case let .packet(channel, packet):
      if channel == self.channels.video {
        handleVideo(packet)
      } else if let audioChannel = self.channels.audio, channel == audioChannel {
        handleAudio(packet)
      }

    case let .rtcp(report):
      publishAdvertisement(cname: report.cname, name: report.name)
      lock.lock()
      clockAudit.note(
        report: report,
        arrivalUptime: Self.seconds(DispatchTime.now()),
        wallClockNow: Date()
      )
      lock.unlock()

    case let .failed(reason):
      scheduleReconnect(reason: reason)
    }
  }

  private func publishAdvertisement(cname: String?, name: String?) {
    let advertisement = StreamAdvertisement(cname: cname, name: name)
    guard !advertisement.isEmpty else { return }
    lock.lock()
    let handler = streamAdvertisementHandler
    lock.unlock()
    handler?(advertisement)
  }

  private func configure(with description: SDPDescription, channels: RTSPSession.Channels) {
    guard let video = description.video, let codec = video.videoCodec else {
      scheduleReconnect(reason: "no decodable video track")
      return
    }

    let decoder = VideoToolboxDecoder(codec: codec) { [weak self] pixelBuffer, presentationTime in
      self?.publish(pixelBuffer: pixelBuffer, presentationTime: presentationTime)
    }
    // Parameter sets from the SDP mean the first keyframe decodes immediately. Waiting for the
    // in-band copy instead leaves the tile black until the camera repeats them.
    decoder.setParameterSets(video.parameterSets)

    var audioDecoder: AACAudioDecoder?
    var audioDepacketizer: AACDepacketizer?
    if let audio = description.audio,
       let framing = audio.aacFraming,
       let config = audio.audioSpecificConfig,
       let parsed = AudioSpecificConfig(config) {
      audioDepacketizer = AACDepacketizer(framing: framing)
      audioDecoder = AACAudioDecoder(
        config: parsed,
        magicCookie: config,
        outputSampleRate: AudioSampleBuilder.sampleRate
      )
    }

    lock.lock()
    self.channels = channels
    videoDepacketizer = codec == .hevc ? HEVCDepacketizer() : H264Depacketizer()
    self.decoder = decoder
    self.audioDecoder = audioDecoder
    self.audioDepacketizer = audioDepacketizer
    videoCodec = codec
    videoParameterSets = video.parameterSets
    if let audio = description.audio,
       let config = audio.audioSpecificConfig,
       let parsed = AudioSpecificConfig(config) {
      audioConfig = (config, Double(parsed.sampleRate), parsed.channelCount)
    }
    connectionCount = 1
    failedAttempts = 0
    lastFailure = nil
    lastAccessUnitAt = Date()
    // The codec is known from the SDP, before any picture has been decoded, so the operator's camera
    // list can name it the moment the camera is switched on. Size arrives with the first frame.
    resolvedFormat = SourceFormat(
      width: resolvedFormat?.width ?? 0,
      height: resolvedFormat?.height ?? 0,
      frameRate: frameRateEstimator.frameRate
        ?? resolvedFormat?.frameRate
        ?? Self.assumedFrameRate,
      pixelFormat: VideoToolboxDecoder.outputPixelFormat,
      codecName: codec.displayName
    )
    if let start = pendingWaitStart {
      stats.waitingSeconds += Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000_000
      pendingWaitStart = nil
    }
    lock.unlock()
  }

  // MARK: - Video

  private func handleVideo(_ packet: RTPPacket) {
    lock.lock()
    let intact = videoTracker.observe(packet.sequenceNumber)
    guard let depacketizer = videoDepacketizer else {
      lock.unlock()
      return
    }
    lock.unlock()

    guard let unit = depacketizer.append(packet, sequenceIntact: intact) else { return }

    let arrivedAt = DispatchTime.now()
    let now = Self.seconds(arrivedAt)
    lock.lock()
    videoSSRC = packet.ssrc
    stats.captured &+= 1
    lastAccessUnitAt = Date()
    jitter.noteArrival(at: arrivedAt, isKeyframe: unit.isKeyframe)

    // 90 kHz is the RTP video clock rate these cameras advertise. Unwrapped rather than measured
    // from the session's first timestamp: the 32-bit field wraps every 13 hours, and half that is
    // long enough to reach in one game.
    let elapsed = videoTimeline.unwrap(unit.rtpTimestamp)
    let presentationTime = CMTime(value: CMTimeValue(elapsed), timescale: 90_000)
    jitter.noteLateness(now - presentationTime.seconds, at: arrivedAt)
    frameRateEstimator.note(timestamp: unit.rtpTimestamp)

    // Carried alongside the existing arrival stamp and read by nothing yet: this phase proves the
    // number is right before anything depends on it. Already inside the lock taken above — `lock`
    // is a plain NSLock and taking it again here deadlocks the receive thread on the first packet.
    // Held per frame rather than read back from `lastCorrectedCapture`. The cached value belongs to
    // whichever frame last had an anchor, and stamping this frame with it is how a reconnect — which
    // clears the anchor but not the cache — made a real outage look like no elapsed capture time at
    // all, and so like a glitched timestamp rather than the dropout it was.
    var frameCapture: Double?
    if let videoSSRC,
       let correctedCapture = clockAudit.captureTimeOnLocalClock(
         rtpTimestamp: unit.rtpTimestamp,
         ssrc: videoSSRC
       ) {
      lastCorrectedCapture = correctedCapture
      correctedCaptureAgeSeconds = Date().timeIntervalSince1970 - correctedCapture
      frameCapture = correctedCapture
    }

    // The picture waits here instead of being decoded on the spot. Releasing it against its own
    // timestamp is what turns the camera's burst-and-wait delivery back into even motion.
    playout.note(lateness: now - presentationTime.seconds, at: now)
    pictures.enqueue(
      PendingPicture(unit: unit, presentationTime: presentationTime),
      due: playout.dueTime(presentationSeconds: presentationTime.seconds),
      keepingAtMost: pictureQueueCapacityLocked()
    )

    let id = frameID
    frameID &+= 1
    pendingFrameIDs[presentationTime.value] = id
    // Bounded: a picture that never decodes would otherwise leave its identity behind forever.
    if pendingFrameIDs.count > 240 {
      let stale = pendingFrameIDs.keys.sorted().prefix(120)
      for key in stale { pendingFrameIDs.removeValue(forKey: key) }
    }

    if !unit.parameterSets.isEmpty { videoParameterSets = unit.parameterSets }
    let archive = sinks.compressed
    let codec = videoCodec
    let sets = videoParameterSets
    lock.unlock()

    // The archive is fed here, on arrival, rather than from the delay line: holding a picture back
    // is a courtesy to the operator's eyes, and the file wants the camera's own pacing. A picture
    // assembled across a packet loss is dropped from both — writing known-corrupt bytes would make
    // the recording undecodable at exactly the moment it mattered.
    guard let archive, let codec, !unit.isCorrupt, !unit.data.isEmpty, !sets.isEmpty else { return }
    archive(
      CompressedFrame(
        sourceID: sourceID,
        codec: codec.compressed,
        data: unit.data,
        parameterSets: sets,
        isKeyframe: unit.isKeyframe,
        presentationTime: presentationTime,
        decodeTime: presentationTime,
        wallClock: clock.now,
        captureWallClock: frameCapture.map { WallClock(seconds: $0) },
        frameID: id
      )
    )
  }

  // MARK: - The delay line

  /// How many coded pictures the delay line may hold, at the rate this camera is sending. Called
  /// with `lock` held.
  private func pictureQueueCapacityLocked() -> Int {
    let rate = frameRateEstimator.frameRate ?? Self.assumedFrameRate
    return Int((rate * Self.pictureQueueSeconds).rounded(.up))
  }

  /// Releases whatever has come due, decodes it and publishes it.
  ///
  /// Runs on this source's own queue rather than on the network thread, so a keyframe's decode
  /// cannot hold up reading the socket, and video and audio reach the sinks in one serial order.
  private func drain() {
    let now = Self.seconds(.now())

    lock.lock()
    if let coordinator {
      playout.setFloor(milliseconds: coordinator.programMilliseconds)
      playout.setCeiling(milliseconds: coordinator.latencyCapMilliseconds)
    }
    playout.advance(to: now)
    // Never lead by more than half the buffer: a camera being held only briefly would otherwise be
    // decoding frames it has barely received.
    let lead = min(Self.decodeLead, playout.holdSeconds / 2)
    let toDecode = pictures.release(at: now + lead)
    let dueAudio = audioFrames.release(at: now)
    let decoder = self.decoder
    let audioHandler = sinks.audio
    let buffer = playout.bufferMilliseconds
    let shouldReport = now - lastReportAt >= Self.reportInterval
    if shouldReport { lastReportAt = now }
    lock.unlock()

    if shouldReport, let coordinator { coordinator.report(buffer, for: sourceID) }

    for picture in toDecode {
      autoreleasepool {
        let began = DispatchTime.now()
        let ok = decoder?.decode(picture.unit, presentationTime: picture.presentationTime) ?? false
        let spent = Double(DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds) / 1_000_000_000

        lock.lock()
        stats.deliverySeconds += spent
        if !ok { stats.formatMisses &+= 1 }
        lock.unlock()
      }
    }

    // Decoding above only moves pictures into `decodedFrames`; this is where they reach the app, on
    // their own timestamps, which is the whole point of the exercise.
    lock.lock()
    let ready = decodedFrames.release(at: Self.seconds(.now()))
    let pixelHandler = sinks.pixel
    lock.unlock()

    for frame in ready {
      let began = DispatchTime.now()
      pixelHandler?(frame)
      let spent = Double(DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds) / 1_000_000_000

      lock.lock()
      stats.deliverySeconds += spent
      jitter.noteRelease(at: DispatchTime.now())
      jitter.noteDelivery(milliseconds: spent * 1000, at: DispatchTime.now())
      lock.unlock()
    }

    for frame in dueAudio { audioHandler?(frame) }
  }

  private func startDrain() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + Self.drainInterval, repeating: Self.drainInterval, leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in self?.drain() }

    lock.lock()
    drainTimer?.cancel()
    drainTimer = timer
    lock.unlock()
    timer.resume()
  }

  private static func seconds(_ time: DispatchTime) -> Double {
    Double(time.uptimeNanoseconds) / 1_000_000_000
  }

  /// Called by the decoder, which runs ahead of time, so this queues rather than delivers.
  private func publish(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
    lock.lock()
    // Decode order is presentation order for these cameras, but a stream with reordering would
    // otherwise hand the archive writer a timestamp that moves backwards, which stalls the track.
    // Counted, because dropping silently is how a stalled source timeline once looked like a
    // camera that had simply stopped moving.
    if let last = lastPresentationTime, presentationTime <= last {
      stats.outOfOrderFrames &+= 1
      lock.unlock()
      return
    }
    lastPresentationTime = presentationTime

    let id = pendingFrameIDs.removeValue(forKey: presentationTime.value) ?? frameID
    resolvedFormat = SourceFormat(
      width: CVPixelBufferGetWidth(pixelBuffer),
      height: CVPixelBufferGetHeight(pixelBuffer),
      frameRate: frameRateEstimator.frameRate
        ?? resolvedFormat?.frameRate
        ?? Self.assumedFrameRate,
      pixelFormat: CVPixelBufferGetPixelFormatType(pixelBuffer),
      codecName: resolvedFormat?.codecName ?? videoCodec?.displayName ?? ""
    )
    decodedFrames.enqueue(
      PixelFrame(
        sourceID: sourceID,
        pixelBuffer: pixelBuffer,
        presentationTime: presentationTime,
        wallClock: clock.now,
        // The corrected capture time when the camera's sender reports have anchored one, so how
        // old a picture is can be judged the same way on both transports.
        captureWallClock: lastCorrectedCapture > 0
          ? WallClock(seconds: lastCorrectedCapture)
          : nil,
        frameID: id,
        markerValue: nil
      ),
      due: playout.dueTime(presentationSeconds: presentationTime.seconds),
      keepingAtMost: 8
    )
    lock.unlock()
  }

  // MARK: - Audio

  private func handleAudio(_ packet: RTPPacket) {
    lock.lock()
    audioTracker.observe(packet.sequenceNumber)
    guard let depacketizer = audioDepacketizer else {
      lock.unlock()
      return
    }
    let decoder = audioDecoder
    let wantsMix = sinks.audio != nil
    let archive = sinks.compressedAudio
    let config = audioConfig
    lock.unlock()

    for (offset, accessUnit) in depacketizer.accessUnits(from: packet).enumerated() {
      let step = CompressedAudioFrame.framesPerPacket * Int64(offset)
      let rtpTimestamp = packet.timestamp &+ UInt32(truncatingIfNeeded: step)

      // The archive takes the camera's own AAC. The mixer cannot: it sums several cameras at one
      // rate, so that path still decodes and resamples — but only what reaches the programme, and
      // never what reaches disk.
      if let archive, let config {
        archive(
          CompressedAudioFrame(
            sourceID: sourceID,
            data: accessUnit,
            magicCookie: config.cookie,
            sampleRate: config.sampleRate,
            channelCount: config.channels,
            presentationTime: CMTime(
              value: CMTimeValue(packet.timestamp) + step,
              timescale: CMTimeScale(config.sampleRate)
            ),
            wallClock: clock.now
          )
        )
      }

      guard wantsMix, let decoder, let output = decoder.decode(accessUnit) else { continue }

      lock.lock()
      if audioFormatDescription == nil {
        audioFormatDescription = AudioSampleBuilder.makeFormatDescription(
          AudioSampleBuilder.interleavedInt16Description(
            sampleRate: output.sampleRate,
            channels: UInt32(output.channelCount)
          )
        )
      }
      let formatDescription = audioFormatDescription
      let rate = config?.sampleRate ?? output.sampleRate
      let elapsed = audioTimeline.unwrap(rtpTimestamp)
      let presentationSeconds = rate > 0 ? Double(elapsed) / rate : 0
      let nowUptime = Self.seconds(.now())
      let due = playout.scheduleTime(presentationSeconds: presentationSeconds, nowUptime: nowUptime)
      let dueWall = clock.now + (due - nowUptime)
      lock.unlock()

      guard
        let formatDescription,
        let sampleBuffer = AudioSampleBuilder.makeSampleBuffer(
          samples: output.samples,
          formatDescription: formatDescription,
          presentationTime: CMTime(seconds: presentationSeconds, preferredTimescale: 48_000)
        )
      else { continue }

      // Same delay line as the picture, against the camera's RTP timeline. Stamping arrival time
      // and holding a flat `holdSeconds` stacked every access unit that rode behind a keyframe
      // onto one mix slot, which the operator heard as stutter and pumping.
      lock.lock()
      audioFrames.enqueue(
        AudioFrame(sourceID: sourceID, sampleBuffer: sampleBuffer, wallClock: dueWall),
        due: due,
        keepingAtMost: 120
      )
      lock.unlock()
    }
  }

  // MARK: - Supervision

  /// Watches for a session that is open but silent, which no socket error reports.
  private func startStallWatchdog() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      lock.lock()
      let last = lastAccessUnitAt
      let started = sessionStartedAt
      let isRunning = running
      let hasSession = session != nil
      lock.unlock()

      guard isRunning, hasSession else { return }
      guard StallWatchdog.shouldReconnect(
        now: Date(),
        lastAccessUnitAt: last,
        sessionStartedAt: started,
        timeout: Self.stallTimeout
      ) else { return }
      scheduleReconnect(reason: "no frames for \(Int(Self.stallTimeout))s")
    }

    lock.lock()
    stallTimer?.cancel()
    stallTimer = timer
    lock.unlock()
    timer.resume()
  }

  private func scheduleReconnect(reason: String) {
    lock.lock()
    guard running, reconnectItem == nil else {
      lock.unlock()
      return
    }
    lastFailure = reason

    let session = self.session
    self.session = nil
    let decoder = self.decoder
    self.decoder = nil
    connectionCount = 0
    lastAccessUnitAt = nil
    sessionStartedAt = nil
    failedAttempts += 1
    let attempt = failedAttempts

    // 1, 2, 4, then 8 seconds. Holding at 8 keeps a camera that is switched off from filling the
    // log, while still recovering within a play of it coming back.
    let delay = Self.backoffSeconds[min(attempt - 1, Self.backoffSeconds.count - 1)]
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      lock.lock()
      reconnectItem = nil
      lock.unlock()
      connect()
    }
    reconnectItem = item
    let shouldRelocate = attempt >= Self.attemptsBeforeRelocation
    lock.unlock()

    session?.stop()
    // Invalidate off this source's drain queue. `VTDecompressionSessionInvalidate` waits for
    // in-flight frames, and while it does the session queue keeps enqueueing audio. That wait
    // on the drain queue is how a stalled camera grew the process into gigabytes.
    if let decoder {
      DispatchQueue.global(qos: .utility).async {
        decoder.invalidate()
      }
    }
    queue.asyncAfter(deadline: .now() + delay, execute: item)

    // Repeated failure at a known-good address usually means the camera is answering somewhere
    // else now, which only a fresh scan and a rebind can fix.
    if shouldRelocate { onNeedsRelocation?(sourceID) }
  }
}

/// One second of frame timing, kept as extremes rather than averages.
///
/// A stutter is one late frame in thirty, which no average survives: a tile missing a frame every
/// second still reports 29 fps and a two-millisecond mean. Extremes from the same second are
/// comparable, so the widest arrival gap and the longest single frame's work can be read together —
/// the first says how late a frame was, the second says whether we were the reason.
struct JitterWindow {
  /// Long enough to contain several keyframe cycles, short enough that the two clocks drifting apart
  /// does not masquerade as jitter.
  private static let latenessWindowMilliseconds: Double = 10_000

  private var windowStart = DispatchTime.now()
  private var lastArrival: DispatchTime?
  private var lastRelease: DispatchTime?
  private var gap: Double = 0
  private var gapKeyframe = false
  private var releaseGap: Double = 0
  private var deliver: Double = 0

  private var latenessStart = DispatchTime.now()
  private var latenessMin = Double.greatestFiniteMagnitude
  private var latenessMax = -Double.greatestFiniteMagnitude

  /// The last complete second's figures. Held for a whole second so a reader sampling at 1 Hz sees
  /// every window rather than whichever moment it happened to ask in.
  private(set) var gapMaxMilliseconds: Double = 0
  private(set) var gapWasKeyframe = false
  private(set) var releaseGapMaxMilliseconds: Double = 0
  private(set) var deliverMaxMilliseconds: Double = 0
  private(set) var latenessSpreadMilliseconds: Double = 0

  mutating func noteArrival(at now: DispatchTime, isKeyframe: Bool) {
    if let lastArrival {
      let elapsed = Self.milliseconds(from: lastArrival, to: now)
      if elapsed > gap {
        gap = elapsed
        gapKeyframe = isKeyframe
      }
    }
    lastArrival = now
  }

  /// How far apart the earliest and latest frame were, measured against their own timestamps.
  ///
  /// This is the buffer question stated exactly. A frame is "late" by the difference between when it
  /// arrived and when its presentation time says it belongs; the spread between the least and most
  /// late frame is how much video a player must already be holding to present every one of them on
  /// time. The absolute delay does not matter — a stream uniformly one second behind plays perfectly
  /// smoothly — so only the spread is reported.
  mutating func noteLateness(_ seconds: Double, at now: DispatchTime) {
    latenessMin = min(latenessMin, seconds)
    latenessMax = max(latenessMax, seconds)
    guard Self.milliseconds(from: latenessStart, to: now) >= Self.latenessWindowMilliseconds else {
      return
    }
    latenessSpreadMilliseconds = (latenessMax - latenessMin) * 1000
    latenessMin = .greatestFiniteMagnitude
    latenessMax = -.greatestFiniteMagnitude
    latenessStart = now
  }

  /// The same measurement as `noteArrival`, taken on the way out of the delay line. Arrival is what
  /// the camera and the link did; release is what the screen sees, so the pair together says
  /// whether the buffer is doing its job.
  mutating func noteRelease(at now: DispatchTime) {
    if let lastRelease {
      releaseGap = max(releaseGap, Self.milliseconds(from: lastRelease, to: now))
    }
    lastRelease = now
  }

  /// Closes the window here rather than on arrival: a frame's work belongs to the second its gap was
  /// measured in, and publishing between the two would split a stutter across windows.
  mutating func noteDelivery(milliseconds: Double, at now: DispatchTime) {
    deliver = max(deliver, milliseconds)
    guard Self.milliseconds(from: windowStart, to: now) >= 1000 else { return }
    gapMaxMilliseconds = gap
    gapWasKeyframe = gapKeyframe
    releaseGapMaxMilliseconds = releaseGap
    deliverMaxMilliseconds = deliver
    gap = 0
    gapKeyframe = false
    releaseGap = 0
    deliver = 0
    windowStart = now
  }

  static func milliseconds(from start: DispatchTime, to end: DispatchTime) -> Double {
    guard end.uptimeNanoseconds > start.uptimeNanoseconds else { return 0 }
    return Double(end.uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
  }
}
