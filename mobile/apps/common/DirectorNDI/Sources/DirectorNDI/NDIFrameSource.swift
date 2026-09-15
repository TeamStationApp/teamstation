import CNDI
import CoreMedia
import Foundation
import DirectorCore
import DirectorSources

/// One NDI camera, received and made to look exactly like every other source.
///
/// The shape differs from `RTSPFrameSource` in one way that runs through everything here. RTSP
/// hands us the camera's own access units, so its archive is a byte copy and costs no encoder. The
/// free NDI SDK decodes inside `libndi` and hands us pixels, so **this source encodes its own
/// archive** — one 1080p session per camera, in a pipeline where encode sessions rather than CPU
/// are what runs out. `sinks.compressed` being nil is therefore not just an optimisation: when
/// nothing is recording there is no encoder at all.
///
/// Two capture threads, which the SDK documentation recommends and which matters more here than it
/// would elsewhere: the video thread runs an encoder, and an encoder stalling must not stop audio
/// being collected. `NDIlib_recv_capture_v3` is documented as safe to call from several threads at
/// once for exactly this.
public final class NDIFrameSource: FrameSource, @unchecked Sendable {
  public let sourceID: SourceID
  public let displayName: String

  /// The full `MACHINE (Stream)` name. The only thing `NDIlib_recv_connect` accepts, and the
  /// reason a rename is treated as a new camera.
  private let ndiName: String
  /// The address the finder resolved for this source, when it had one.
  ///
  /// Handed to the receiver alongside the name because connecting by name alone makes the receiver
  /// resolve it again through a finder of its own — one with none of the extra IPs the fallback
  /// sweep supplies. A camera found only because of that sweep could then be listed and not
  /// connected to: measured as `connections=0` and no frames at all, against a camera that was
  /// transmitting perfectly the whole time.
  private let ndiURL: String
  private let clock: DirectorClock
  /// Where the archive's encoding comes from. Read each time archiving starts rather than once at
  /// launch, so a take is recorded with the raw camera settings in force when it began.
  private let archiveEncodingProvider: @Sendable () -> EncodeSettings
  /// The encoding of the archive being written now.
  private var archiveEncoding: EncodeSettings
  private var encodeCodec: CompressedFrame.Codec { archiveEncoding.codec == .h264 ? .h264 : .hevc }
  /// How long a source may deliver nothing before it is reported as silent. Matches the RTSP
  /// path's timeout so an operator reads one number for both transports.
  private static let stallTimeout: TimeInterval = 5
  /// 1, 2, 4, then 8 seconds between rebuilds, held at 8 — the same schedule as RTSP, for the same
  /// reason: a camera that is switched off must not fill the log, and one that comes back should
  /// be found within a play of it doing so.
  private static let backoffSeconds: [TimeInterval] = [ 1, 2, 4, 8 ]
  /// The delay line, mirroring RTSP's numbers exactly so both transports hold the same way.
  private static let drainInterval: TimeInterval = 0.004
  private static let reportInterval: TimeInterval = 1
  /// The delay line's ceiling is two seconds; holding more than that is a queue growing with
  /// nowhere to release to.
  private static let pictureQueueSeconds: Double = 2
  /// How much of the pool the delay line leaves free for arrivals to bunch up in. The line's
  /// ceiling is set that far below the pool, so a burst lands in the headroom instead of evicting.
  private static let poolHeadroomSeconds: Double = 0.25
  public static let defaultSeedMilliseconds: Double = 300
  private let wantsLowBandwidth: Bool

  /// The archive encode runs here, never on the receive thread.
  ///
  /// `VTCompressionSessionEncodeFrame` blocks once the encoder's queue is full, so encoding inline
  /// makes a slow encoder throttle *reception* — the live picture collapses along with the
  /// archive, and the operator loses both. It is the same rule the archive writer already follows:
  /// a write must never be what delays reading the next frame.
  private let encodeQueue: DispatchQueue
  /// Frames handed to `encodeQueue` and not yet encoded. Past `maximumEncodeBacklog` the frame is
  /// dropped rather than queued, because an unbounded queue in front of an encoder that cannot
  /// keep up is how this app has already run itself out of memory once.
  private var encodeBacklog = 0
  private static let maximumEncodeBacklog = 4

  private let videoConverter = NDIVideoFrameConverter()
  private let audioConverter = NDIAudioFrameConverter()
  private let receiveClock: NDIReceiveClock

  private let lock = NSLock()
  private var receiver: NDIlib_recv_instance_t?
  /// When the last video frame arrived, and when this source was started. The pair the stall
  /// watchdog needs: without the start time, a receiver that never delivers a first frame looks
  /// healthy for ever rather than silent from the outset.
  private var lastVideoAt: Date?
  private var startedAt: Date?
  /// Entered for each capture thread as it starts and left as its loop returns, so a receiver is
  /// destroyed only once nothing can still be inside `NDIlib_recv_capture_v3` on it. A fixed sleep
  /// used to stand in for this, and the margin over a 100 ms capture timeout was whatever the
  /// scheduler left — nothing, on an iPad throttled under three 1080p60 receivers.
  private let captureThreads = DispatchGroup()
  private static let captureThreadExitTimeout: TimeInterval = 1
  private var running = false
  /// Silence supervision, mirroring `RTSPFrameSource`. The SDK does not reconnect a receiver whose
  /// sender rebooted underneath it: a Cosmo C2 restarted and streamed 58 fps to another machine for
  /// fifteen minutes while this receiver sat at `connections=1` receiving nothing, and only
  /// throwing the receiver away and making a new one brought the tile back.
  /// Frames wait here and are released against their own timestamps, which is what turns the
  /// transport's burst-and-wait delivery back into even motion. RTSP has always had this; NDI
  /// drew every frame on arrival with `playout 0 ms, depth 0`, and on the multi-TCP fallback —
  /// bursty, measured at 17–58 fps against a sender pacing an exact 60 — that unevenness went
  /// straight to the screen while the phones beside it, buffered half a second, looked smooth.
  private let coordinator: PlayoutCoordinator?
  private var playout: PlayoutController
  /// The longest hold the pixel pool can honour, from the last frame's rate and pool size. `nil`
  /// until the first frame has sized the pool.
  private var poolHoldMilliseconds: Double?
  private var pictures = PlayoutQueue<PixelFrame>()
  /// Maps this source's presentation timeline onto the uptime clock the delay line schedules on.
  ///
  /// `NDIReceiveClock` starts its timeline at zero and steps it per frame, which is right for the
  /// archive and wrong for the delay line: `dueTime` is `presentation + offset`, and that offset is
  /// clamped to a couple of seconds, so a presentation value near zero is due at uptime zero --
  /// hours in the past. Every frame came due the instant it arrived, the queue never held anything,
  /// and the burstiness the delay line exists to absorb went straight to the screen. Measured with
  /// the RTSP tile beside it holding thirty frames while this one held none, both nominally on the
  /// same 500 ms delay.
  ///
  /// Anchored once from the first frame's arrival rather than tracked, so the hold stays fixed.
  ///
  /// Taken against the sender's own capture clock, not the stepped presentation timeline. That
  /// timeline advances at the *measured* frame rate, and a measurement that is fractionally low --
  /// 58.67 against a sender pacing 60, as this camera reads -- makes it slip behind real time by a
  /// second a minute. Every frame then arrives "late", the offset pins at its ceiling, the queue
  /// drains and the hold is gone again. The capture clock advances at real time by construction, so
  /// the mapping stays put.
  private var presentationAnchorSeconds: Double?
  /// Evens out the sender's capture stamps before they are scheduled. Scheduling on them raw put
  /// their 3–37 ms scatter straight on screen; see `CaptureTimelineSmoother`.
  private var captureSmoother = CaptureTimelineSmoother()
  /// Arrival and release pacing, the pair that says whether the delay line is doing its job.
  ///
  /// RTSP has published these since the beginning; NDI published nothing, so a tile that visibly
  /// stuttered could not be told apart from a sender that bursts. Arrival is what the camera and
  /// the link did, release is what the screen saw: a large arrival gap with a small release gap is
  /// the buffer working, and both large is the buffer being bypassed.
  private var lastArrivalUptime: Double?
  private var lastReleaseUptime: Double?
  private var arrivalGapWindowMax: Double = 0
  private var releaseGapWindowMax: Double = 0
  private var gapWindowStart: Double = 0
  private var arrivalGapPublished: Double = 0
  private var releaseGapPublished: Double = 0

  /// Held for a whole second so a reader sampling at 1 Hz sees every window rather than whichever
  /// moment it happened to ask in.
  private func noteGapWindow(now: Double) {
    guard now - gapWindowStart >= 1 else { return }
    arrivalGapPublished = arrivalGapWindowMax
    releaseGapPublished = releaseGapWindowMax
    arrivalGapWindowMax = 0
    releaseGapWindowMax = 0
    gapWindowStart = now
  }
  private var drainTimer: DispatchSourceTimer?
  private var lastReportAt: Double = 0
  private let playoutQueue: DispatchQueue
  private var stallTimer: DispatchSourceTimer?
  private var reconnectItem: DispatchWorkItem?
  private var failedAttempts = 0
  /// Silence measured across reconnects; see `SilenceClock`.
  private var silence = SilenceClock()
  private let supervisionQueue = DispatchQueue(label: "co.gamestation.director.ndi.supervise")
  private var sinks = FrameSinks()

  /// Nothing is encoded until the router says an archive is reading. Four idle preview tiles
  /// holding four 1080p encode sessions is how this app runs out of the only resource it has too
  /// few of.
  private var isArchiving = false
  /// Set when the archive was asked for but the encode budget had no room. The camera still
  /// previews and still cuts to programme; only its own recording is refused, which is the existing
  /// rule for starting a recording applied one level down.
  private var archiveRefused = false
  /// `WireVideoEncoder` could not be made for this camera's archive. Reported until one can be.
  private var encoderUnavailable = false
  private static let encoderUnavailableReason = "no encoder available for this camera's archive"
  private var decimator = ArchiveDecimator()
  /// The archive's own clock, at the raw camera frame rate. See `ArchiveTicker`.
  private var ticker = ArchiveTicker(frameRate: 60)
  private var archiveTimer: DispatchSourceTimer?
  /// The newest decoded picture, waiting for the archive's next tick.
  private struct ArchivePicture {
    let buffer: CVPixelBuffer
    /// Wall-clock seconds when it arrived.
    let arrivedWall: Double
    /// Its smoothed capture time on our clock, when the sender stamps its frames.
    let captureWall: Double?
    let frameID: UInt64
  }
  private var archivePicture: ArchivePicture?
  private var archiveNewest: ArchiveTicker.Picture?
  private var archiveSequence: UInt64 = 0
  /// Fits pictures to the raw camera resolution. Nil only if one could not be made, in which case
  /// the camera's own size is recorded rather than nothing.
  private var archiveScaler: ArchiveScaler?
  /// Refusals from sessions this camera has already discarded, so the count describes the camera
  /// rather than whichever encoder it happens to be holding.
  private var archiveRefusalsCarried: UInt64 = 0
  private var videoEncoder: WireVideoEncoder?
  private var audioEncoder: WireAudioEncoder?
  private var encoderWidth = 0
  private var encoderHeight = 0
  private var encoderRate: Double = 0
  /// What the encode has to carry through but VideoToolbox will not: the frame's identity, so a
  /// picture on disk can be traced to the frame that arrived, and the moment it was taken, which is
  /// what a segment's start time is recorded from. Keyed by presentation time, the only thing
  /// VideoToolbox does carry.
  ///
  /// Taking the segment start from arrival instead is why two cameras rewound to the same moment
  /// land in different places — each segment would carry that camera's own delivery delay.
  private struct PendingFrame {
    let frameID: UInt64
    let captureWallClock: WallClock?
  }

  private var pendingFrames: [CMTimeValue: PendingFrame] = [:]
  private var audioSampleIndex: Int64 = 0
  private var audioFormat: CMAudioFormatDescription?

  private var currentFormat: SourceFormat?
  private var stats = ReceiveStats()
  private var rejections = NDIRejectionCounters()
  private var lastPerformanceDropped: Int64 = 0
  private var upstreamConnections = 0

  /// Told when the camera's picture geometry changes under an open recording, which no single
  /// fMP4 track can hold. The archive layer answers by opening a fresh writer.
  public var onFormatChange: (@Sendable (SourceID) -> Void)?

  public init(
    sourceID: SourceID,
    displayName: String,
    ndiName: String,
    ndiURL: String = "",
    archiveEncoding: @escaping @Sendable () -> EncodeSettings = { AppConfig().rawCameraEncoding },
    lowBandwidth: Bool = false,
    coordinator: PlayoutCoordinator? = nil,
    clock: DirectorClock = SystemClock()
  ) {
    self.coordinator = coordinator
    self.playout = PlayoutController(
      seedMilliseconds: coordinator?.seedMilliseconds(for: sourceID) ?? Self.defaultSeedMilliseconds
    )
    self.playoutQueue = DispatchQueue(
      label: "co.gamestation.director.ndi.playout.\(sourceID.slug)",
      qos: .userInitiated
    )
    self.sourceID = sourceID
    self.displayName = displayName
    self.ndiName = ndiName
    self.ndiURL = ndiURL
    self.archiveEncodingProvider = archiveEncoding
    self.archiveEncoding = archiveEncoding()
    self.wantsLowBandwidth = lowBandwidth
    self.clock = clock
    self.receiveClock = NDIReceiveClock(clock: clock)
    self.encodeQueue = DispatchQueue(
      label: "co.gamestation.director.ndi.encode.\(sourceID.slug)",
      qos: .userInitiated
    )
  }

  deinit {
    stop()
  }

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  public var format: SourceFormat? {
    lock.lock()
    defer { lock.unlock() }
    return currentFormat
  }

  public var connections: Int {
    lock.lock()
    defer { lock.unlock() }
    return upstreamConnections
  }

  public var receiveStats: ReceiveStats {
    lock.lock()
    defer { lock.unlock() }
    var snapshot = stats
    snapshot.outOfOrderFrames = receiveClock.outOfOrderFrames
    snapshot.senderClockRestarts = receiveClock.clockRestarts
    // From the last picture across reconnects, not from this session; see `SilenceClock`.
    snapshot.stalledForSeconds = running
      ? silence.stalledForSeconds(now: Date(), timeout: Self.stallTimeout)
      : 0
    snapshot.decodeSessions = videoEncoder == nil ? 0 : 1
    snapshot.playoutMilliseconds = (playout.bufferMilliseconds * 10).rounded() / 10
    snapshot.playoutLateFrames = playout.lateFrames
    snapshot.playoutDepth = pictures.count
    snapshot.arrivalGapMaxMilliseconds = (arrivalGapPublished * 10).rounded() / 10
    snapshot.releaseGapMaxMilliseconds = (releaseGapPublished * 10).rounded() / 10
    return snapshot
  }

  /// Which rule threw frames away, for `/dump-state`. A rejection count without a reason cannot
  /// distinguish a 4K camera from a corrupt one.
  public var rejectionSummary: String {
    lock.lock()
    defer { lock.unlock() }
    return rejections.summary
  }

  public func start(sinks: FrameSinks) throws {
    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    guard NDIRuntime.shared.acquire() else {
      lock.unlock()
      throw FrameSourceError.unavailable(
        NDIRuntime.shared.unavailableReason ?? "the NDI library is not available"
      )
    }

    self.sinks = sinks
    running = true
    failedAttempts = 0
    receiveClock.reset()
    audioConverter.reset()
    audioSampleIndex = 0
    audioFormat = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description()
    )
    lock.unlock()

    do {
      try openReceiver()
    } catch {
      lock.lock()
      running = false
      self.sinks = FrameSinks()
      lock.unlock()
      NDIRuntime.shared.release()
      throw error
    }
    startDrain()
    startStallWatchdog()
  }

  /// Makes the receiver and starts its two capture threads. Called once from `start`, and again
  /// by the watchdog every time a receiver has to be replaced; everything about the source that
  /// is not the receiver — sinks, encoder, archive, clocks — is left alone.
  private func openReceiver() throws {
    let created: NDIlib_recv_instance_t? = ndiName.withCString { name in
      ndiURL.withCString { address in
      "GS Director".withCString { receiverName in
        var source = NDIlib_source_t()
        source.p_ndi_name = name
        source.p_url_address = ndiURL.isEmpty ? nil : address

        var settings = NDIlib_recv_create_v3_t()
        settings.source_to_connect_to = source
        // "Using NDIlib_recv_color_format_fastest for receiving will yield the best performance."
        // On this platform that is 8-bit UYVY, which is one conversion from the NV12 the rest of
        // the pipeline runs on — as against `best`, which would hand us 16-bit P216 and cost a
        // precision-discarding pass per frame to reach the same place.
        settings.color_format = NDIlib_recv_color_format_fastest
        settings.bandwidth = wantsLowBandwidth
          ? NDIlib_recv_bandwidth_lowest
          : NDIlib_recv_bandwidth_highest
        // The pipeline is progressive throughout and the archive writer has no notion of fields,
        // so the SDK is asked to de-interlace rather than us discovering half-height pictures
        // downstream.
        settings.allow_video_fields = false
        settings.p_ndi_recv_name = receiverName
        return NDIlib_recv_create_v3(&settings)
      }
      }
    }

    guard let created else {
      throw FrameSourceError.failedToStart("could not create an NDI receiver for \(ndiName)")
    }

    lock.lock()
    // Creating took time, and `stop` may have run meanwhile — a cancelled reconnect item that was
    // already executing carries on regardless. Installing this receiver now would leave it alive
    // and unowned: a phantom connection on the camera for the life of the process.
    guard running, receiver == nil else {
      lock.unlock()
      NDIlib_recv_destroy(created)
      return
    }
    receiver = created
    startedAt = Date()
    silence.sessionStarted(at: startedAt ?? Date())
    lastVideoAt = nil
    upstreamConnections = 0
    // Tell the sender who we are. Not decoration: it is what appears in a camera's own connection
    // list, and an unidentified receiver is indistinguishable from an intruder when someone is
    // working out why a camera has three connections.
    var product = NDIlib_metadata_frame_t()
    let identity = """
      <ndi_product long_name="GS Director" short_name="GS Director" \
      manufacturer="GameStation" model_name="Director" />
      """
    identity.withCString { pointer in
      product.p_data = UnsafeMutablePointer(mutating: pointer)
      product.length = Int32(identity.utf8.count + 1)
      NDIlib_recv_add_connection_metadata(created, &product)
    }
    lock.unlock()

    // Threads rather than Tasks: both bodies park in a blocking SDK call for up to a tenth of a
    // second at a time, and parking a cooperative pool thread is how an app stops scheduling
    // everything else.
    // The closure leaves the group, not the loop body: a thread that starts after the source has
    // already been released would find `self` nil and skip the loop, and a group disposed with an
    // outstanding `enter` is an abort, not a leak.
    let group = captureThreads
    let video = Thread { [weak self] in
      defer { group.leave() }
      self?.receiveVideo()
    }
    video.name = "co.gamestation.director.ndi.video.\(sourceID.slug)"
    video.qualityOfService = .userInitiated

    let audio = Thread { [weak self] in
      defer { group.leave() }
      self?.receiveAudio()
    }
    audio.name = "co.gamestation.director.ndi.audio.\(sourceID.slug)"
    audio.qualityOfService = .userInitiated

    captureThreads.enter()
    captureThreads.enter()
    video.start()
    audio.start()
  }

  /// Waits for both capture threads to leave the receiver, bounded so a wedged SDK call cannot
  /// hang the caller. On timeout the instance is still destroyed: a leaked receiver is preferable
  /// to a stalled stop, and a thread still inside the SDK past a full second is the SDK's problem.
  private func waitForCaptureThreads() {
    _ = captureThreads.wait(timeout: .now() + Self.captureThreadExitTimeout)
  }

  // MARK: - Playout

  /// Releases whatever has come due and publishes it, on this source's own queue so the SDK's
  /// capture thread is never the one waiting on a renderer.
  private func drain() {
    let now = Self.seconds(.now())
    lock.lock()
    if let coordinator { playout.setFloor(milliseconds: coordinator.programMilliseconds) }
    // The pool bounds the hold, not only the queue. A ceiling the pool cannot honour would have the
    // line evicting its earliest-due picture on every arrival — nothing ever comes due, the tile
    // freezes and the archive keeps recording. Below the pool, the operator's cap wins.
    if let poolHoldMilliseconds {
      playout.setCeiling(milliseconds: min(
        coordinator?.latencyCapMilliseconds ?? poolHoldMilliseconds,
        poolHoldMilliseconds
      ))
    } else if let coordinator {
      playout.setCeiling(milliseconds: coordinator.latencyCapMilliseconds)
    }
    playout.advance(to: now)
    let due = pictures.release(at: now)
    if !due.isEmpty {
      if let last = lastReleaseUptime {
        releaseGapWindowMax = max(releaseGapWindowMax, (now - last) * 1000)
      }
      lastReleaseUptime = now
    }
    noteGapWindow(now: now)
    let handler = sinks.pixel
    let buffer = playout.bufferMilliseconds
    let shouldReport = now - lastReportAt >= Self.reportInterval
    if shouldReport { lastReportAt = now }
    lock.unlock()

    if shouldReport, let coordinator { coordinator.report(buffer, for: sourceID) }
    for picture in due { handler?(picture) }
  }

  private func startDrain() {
    let timer = DispatchSource.makeTimerSource(queue: playoutQueue)
    timer.schedule(
      deadline: .now() + Self.drainInterval,
      repeating: Self.drainInterval,
      leeway: .milliseconds(1)
    )
    timer.setEventHandler { [weak self] in self?.drain() }
    lock.lock()
    drainTimer?.cancel()
    drainTimer = timer
    lock.unlock()
    timer.resume()
  }

  /// The delay line runs on uptime, as RTSP's does, so a wall-clock step cannot move every frame's
  /// due time at once.
  private static func seconds(_ time: DispatchTime) -> Double {
    Double(time.uptimeNanoseconds) / 1_000_000_000
  }

  // MARK: - Supervision

  /// Watches for a receiver that is connected and silent, which the SDK never reports.
  private func startStallWatchdog() {
    let timer = DispatchSource.makeTimerSource(queue: supervisionQueue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      lock.lock()
      let last = lastVideoAt
      let started = startedAt
      let isRunning = running
      let hasReceiver = receiver != nil
      let waiting = reconnectItem != nil
      lock.unlock()
      guard isRunning, hasReceiver, !waiting else { return }
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

  /// Throws the receiver away and makes another after a backoff. The capture threads exit on
  /// their next wake once `receiver` is nil, which their 100 ms capture timeout bounds; the old
  /// instance is destroyed only after that, as `stop` does, so nothing frees it under them.
  private func scheduleReconnect(reason: String) {
    lock.lock()
    guard running, reconnectItem == nil else {
      lock.unlock()
      return
    }
    let old = receiver
    receiver = nil
    startedAt = nil
    lastVideoAt = nil
    upstreamConnections = 0
    failedAttempts += 1
    let attempt = failedAttempts
    playout = playout.reset()
    pictures.removeAll()
    // The timeline restarts with the receiver, so the mapping onto uptime has to be taken again.
    presentationAnchorSeconds = nil
    captureSmoother.reset()
    stats.status = reason
    stats.reconnects &+= 1
    let delay = Self.backoffSeconds[min(attempt - 1, Self.backoffSeconds.count - 1)]
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      lock.lock()
      reconnectItem = nil
      let stillRunning = running
      lock.unlock()
      guard stillRunning else { return }
      do {
        try openReceiver()
      } catch {
        scheduleReconnect(reason: "could not make a receiver: \(error)")
      }
    }
    reconnectItem = item
    lock.unlock()

    if let old {
      waitForCaptureThreads()
      NDIlib_recv_destroy(old)
    }
    supervisionQueue.asyncAfter(deadline: .now() + delay, execute: item)
  }

  public func setArchiving(_ isArchiving: Bool) {
    lock.lock()
    guard isArchiving != self.isArchiving else {
      lock.unlock()
      return
    }
    let previousVideo = videoEncoder
    if isArchiving {
      guard NDIArchiveBudget.shared.acquire(sourceID.rawValue) else {
        archiveRefused = true
        self.isArchiving = false
        stats.status = Self.archiveRefusedReason
        lock.unlock()
        return
      }
      archiveRefused = false
      self.isArchiving = true
      decimator.reset()
      audioEncoder = WireAudioEncoder(channelCount: 1)
      archiveEncoding = archiveEncodingProvider()
      ticker = ArchiveTicker(frameRate: archiveEncoding.frameRate)
      archivePicture = nil
      archiveNewest = nil
      archiveScaler = ArchiveScaler(
        width: archiveEncoding.resolution.width,
        height: archiveEncoding.resolution.height
      )
    } else {
      self.isArchiving = false
      archiveRefused = false
      NDIArchiveBudget.shared.release(sourceID.rawValue)
      encoderUnavailable = false
      // The video encoder is dropped here and rebuilt on the first archived frame, so the session
      // is genuinely returned rather than parked. Rebuilding costs one frame at the start of a
      // recording, which is a keyframe anyway.
      videoEncoder = nil
      audioEncoder = nil
      encoderWidth = 0
      encoderHeight = 0
      pendingFrames.removeAll()
      decimator.reset()
      archivePicture = nil
      archiveNewest = nil
      archiveScaler = nil
      archiveTimer?.cancel()
      archiveTimer = nil
    }
    lock.unlock()
    if isArchiving { startArchiveTimer() }
    // On the encode queue, so the teardown can never overlap an `encode` in flight on the same
    // session — VideoToolbox does not document that as safe. Asynchronous, because this is also
    // reached from `deinit`, which may itself be running on that queue.
    if !isArchiving, let previousVideo { encodeQueue.async { previousVideo.finish() } }
  }

  public func stop() {
    lock.lock()
    guard running else {
      lock.unlock()
      return
    }
    running = false
    let wasArchiving = isArchiving
    isArchiving = false
    archiveRefused = false
    encoderUnavailable = false
    let receiver = self.receiver
    let encoder = videoEncoder
    self.receiver = nil
    stallTimer?.cancel()
    stallTimer = nil
    reconnectItem?.cancel()
    reconnectItem = nil
    drainTimer?.cancel()
    drainTimer = nil
    pictures.removeAll()
    startedAt = nil
    lastVideoAt = nil
    silence.stop()
    videoEncoder = nil
    audioEncoder = nil
    pendingFrames.removeAll()
    archiveTimer?.cancel()
    archiveTimer = nil
    archivePicture = nil
    archiveNewest = nil
    sinks = FrameSinks()
    upstreamConnections = 0
    lock.unlock()

    // The slot is a count of encode sessions; a stop that kept it would cost a later camera its
    // archive with nothing in telemetry to say why.
    if wasArchiving { NDIArchiveBudget.shared.release(sourceID.rawValue) }
    // The capture loops see `running == false` on their next wake, which the 100 ms capture
    // timeout bounds; the receiver is destroyed only once both have actually left it.
    if let encoder { encodeQueue.async { encoder.finish() } }
    if let receiver {
      waitForCaptureThreads()
      NDIlib_recv_destroy(receiver)
    }
    NDIRuntime.shared.release()
  }

  // MARK: - Video

  private func receiveVideo() {
    while true {
      lock.lock()
      let receiver = self.receiver
      let running = self.running
      lock.unlock()
      guard running, let receiver else { return }

      var frame = NDIlib_video_frame_v2_t()
      let waitStart = Date()
      let type = NDIlib_recv_capture_v3(receiver, &frame, nil, nil, 100)
      let waited = Date().timeIntervalSince(waitStart)

      switch type {
      case NDIlib_frame_type_video:
        let deliverStart = Date()
        handle(video: frame)
        // Freed only after the frame has been copied and encoded. The SDK keeps a short queue and
        // holding frames backs it up — which is precisely what `recv_get_performance` then reports
        // as dropped, so the number stays honest about our own slowness.
        NDIlib_recv_free_video_v2(receiver, &frame)
        record(waiting: waited, delivering: Date().timeIntervalSince(deliverStart))

      case NDIlib_frame_type_status_change:
        // Documented as "recheck the device's properties" — PTZ, recording, web control. Nothing
        // here needs those, but the connection count is worth refreshing because it is how a tile
        // tells "discovered but unreachable" from "connected and silent".
        refreshConnections()

      default:
        record(waiting: waited, delivering: 0)
      }
    }
  }

  private func handle(video frame: NDIlib_video_frame_v2_t) {
    lock.lock()
    stats.captured += 1
    let sinks = self.sinks
    lock.unlock()

    if let rejection = NDIFrameValidator.accept(frame) {
      lock.lock()
      rejections.record(rejection)
      if rejection == .unsupportedFourCC { stats.formatMisses += 1 }
      stats.status = rejection.reason
      lock.unlock()
      return
    }

    lock.lock()
    lastVideoAt = Date()
    silence.notePicture(at: lastVideoAt ?? Date())
    failedAttempts = 0
    lock.unlock()

    guard let timing = receiveClock.timing(for: frame) else { return }

    let width = Int(frame.xres)
    let height = Int(frame.yres)
    // The measured rate, not `frame_rate_N/D`. This is the value the archive encoder's keyframe
    // cadence and instant replay's pacing are both built on, so a camera that misdeclares its rate
    // would otherwise mis-time its own archive and replay at the wrong speed.
    let rate = receiveClock.measuredFrameRate
      ?? Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
    updateFormat(width: width, height: height, rate: rate, fourCC: frame.FourCC)

    let copyStarted = Date()
    guard let pixelBuffer = videoConverter.convert(frame) else {
      lock.lock()
      stats.poolMisses += 1
      lock.unlock()
      return
    }
    let copyElapsed = Date().timeIntervalSince(copyStarted) * 1_000

    let publishStarted = Date()
    let picture = PixelFrame(
      sourceID: sourceID,
      pixelBuffer: pixelBuffer,
      presentationTime: timing.presentationTime,
      wallClock: clock.now,
      captureWallClock: timing.captureWallClock,
      frameID: timing.frameID
    )
    // Held rather than published: the drain releases it when it is due. The archive encode below
    // is not held — it takes the pixels straight from here, so what reaches disk is unaffected.
    let presentationSeconds = timing.presentationTime.seconds
    let arrived = Self.seconds(.now())
    var smoothedCaptureSeconds = timing.captureWallClock?.seconds ?? 0
    // Never more than the pool can lend, less a few for the renderer, compositor and encoder to be
    // holding; a line longer than the pool starves itself into `poolMisses`. Read here, on the
    // thread that owns the converter, and handed to the drain as the hold it may not exceed.
    let poolFrames = max(8, videoConverter.maximumBuffers - 8)
    lock.lock()
    if let last = lastArrivalUptime {
      arrivalGapWindowMax = max(arrivalGapWindowMax, (arrived - last) * 1000)
    }
    lastArrivalUptime = arrived
    noteGapWindow(now: arrived)
    poolHoldMilliseconds = max(0, Double(poolFrames) / rate - Self.poolHeadroomSeconds) * 1000
    // Scheduled against whichever clock actually tracks real time: the sender's capture stamp when
    // it gave one, the stepped presentation timeline only as a fallback.
    let timelineSeconds = captureSmoother.place(
      capture: timing.captureWallClock?.seconds ?? presentationSeconds,
      period: 1 / rate
    )
    smoothedCaptureSeconds = timelineSeconds
    let anchor = presentationAnchorSeconds ?? (arrived - timelineSeconds)
    presentationAnchorSeconds = anchor
    // The same instant, expressed on the clock the delay line schedules against.
    let scheduled = timelineSeconds + anchor
    _ = playout.note(lateness: arrived - scheduled, at: arrived)
    pictures.enqueue(
      picture,
      due: playout.dueTime(presentationSeconds: scheduled),
      keepingAtMost: min(Int((rate * Self.pictureQueueSeconds).rounded(.up)), poolFrames)
    )
    lock.unlock()
    let publishElapsed = Date().timeIntervalSince(publishStarted) * 1_000

    lock.lock()
    stats.copyMilliseconds += (copyElapsed - stats.copyMilliseconds) * 0.1
    stats.publishMilliseconds += (publishElapsed - stats.publishMilliseconds) * 0.1
    lock.unlock()

    // The newest picture waits for the archive's next tick; see `archiveTick`.
    lock.lock()
    if isArchiving, sinks.compressed != nil {
      archiveSequence &+= 1
      archivePicture = ArchivePicture(
        buffer: pixelBuffer,
        arrivedWall: picture.wallClock.seconds,
        // The smoothed capture time, not the raw stamp: a segment's start on the recording's wall
        // clock comes from its first frame's entry here, and the Cosmo's raw stamps jitter enough
        // that rec-401's NDI segments started up to 90 ms off the three-second step their frames
        // kept, which placed alternate segments of the export at visibly different offsets.
        captureWall: timing.captureWallClock == nil ? nil : smoothedCaptureSeconds,
        frameID: timing.frameID
      )
      archiveNewest = ArchiveTicker.Picture(arrived: arrived, sequence: archiveSequence)
    }
    lock.unlock()
  }

  // MARK: - The archive's clock

  /// Starts the archive's own clock at the raw camera frame rate. See `ArchiveTicker`.
  private func startArchiveTimer() {
    lock.lock()
    archiveTimer?.cancel()
    let period = DispatchTimeInterval.nanoseconds(
      Int(1_000_000_000 / Double(max(1, archiveEncoding.frameRate)))
    )
    let timer = DispatchSource.makeTimerSource(queue: encodeQueue)
    timer.schedule(deadline: .now() + period, repeating: period, leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in self?.archiveTick() }
    archiveTimer = timer
    lock.unlock()
    timer.resume()
  }

  /// One tick of the archive's clock, on `encodeQueue`. The newest picture is encoded as the tick's
  /// frame and stamped with the tick's own time, never with anything measured from the camera, so
  /// no estimate of the camera's frame rate can reach the recording's timeline.
  private func archiveTick() {
    let now = Self.seconds(.now())
    lock.lock()
    guard running, isArchiving, sinks.compressed != nil else {
      lock.unlock()
      return
    }
    guard case let .encode(index, _) = ticker.tick(at: now, newest: archiveNewest),
          let picture = archivePicture
    else {
      lock.unlock()
      return
    }
    // Thinning ahead of the encoder, not behind it: an overloaded archive stays evenly timed at a
    // fraction of the rate, where letting a queue overflow leaves it missing frames at unpredictable
    // moments. Both cost the same; only one is a usable angle.
    let backlogFull = encodeBacklog >= Self.maximumEncodeBacklog
    let wanted = decimator.shouldEncode(backlogFull: backlogFull)
    let stride = decimator.stride
    stats.archiveStride = stride
    guard wanted, !backlogFull else {
      if backlogFull { stats.archiveDropped += 1 }
      stats.archiveBacklog = encodeBacklog
      lock.unlock()
      return
    }
    let settings = archiveEncoding
    let presentationTime = CMTime(value: index, timescale: CMTimeScale(settings.frameRate))
    // A picture encoded again on a later tick moves on with the tick on the capture timeline, as
    // the camera's own clock would have while it stalled.
    let captureWall = picture.captureWall.map {
      WallClock(seconds: $0 + (clock.now.seconds - picture.arrivedWall))
    }
    pendingFrames[presentationTime.value] = PendingFrame(
      frameID: picture.frameID,
      captureWallClock: captureWall
    )
    // Bounded so a stalled encoder cannot grow this without limit. Two seconds of 60 fps is far
    // more slack than the encoder ever needs, and the oldest entry is the one whose frame is least
    // likely still to be in flight.
    while pendingFrames.count > 128, let oldest = pendingFrames.keys.min() {
      pendingFrames.removeValue(forKey: oldest)
    }
    encodeBacklog += 1
    stats.archiveBacklog = encodeBacklog
    let scaler = archiveScaler
    lock.unlock()

    let scaled = scaler?.scale(picture.buffer) ?? picture.buffer
    let encoder = encoderForArchive(
      width: CVPixelBufferGetWidth(scaled),
      height: CVPixelBufferGetHeight(scaled),
      rate: Double(settings.frameRate)
    )
    // Decimation changes the rate the encoder is actually fed, and VideoToolbox reckons its
    // keyframe interval against the rate it was told. Without this a decimated archive's segments
    // stretch past three seconds and stop matching every other source's — measured at 7.4 s for a
    // stride-4 HEVC archive that should have been cutting at 3.
    encoder?.setExpectedFrameRate(Double(settings.frameRate) / Double(max(1, stride)))
    encoder?.encode(
      scaled,
      presentationTime: presentationTime,
      duration: CMTime(value: 1, timescale: CMTimeScale(settings.frameRate))
    )
    lock.lock()
    encodeBacklog -= 1
    stats.archiveBacklog = encodeBacklog
    stats.archiveEncoded += 1
    stats.archiveEncodeRefused = archiveRefusalsCarried + (encoder?.refusedFrames ?? 0)
    if let status = encoder?.lastEncodeStatus, status != noErr {
      stats.archiveEncodeStatus = Int(status)
    }
    lock.unlock()
  }

  /// Creates the archive encoder on first need, and replaces it when the camera's geometry moves.
  ///
  /// Deferred rather than made in `start` because an encoder is the scarce resource here: a camera
  /// that is only being previewed should not hold one, and four idle tiles holding four sessions is
  /// the difference between recording five cameras and recording one.
  private func encoderForArchive(width: Int, height: Int, rate: Double) -> WireVideoEncoder? {
    lock.lock()
    if let existing = videoEncoder, encoderWidth == width, encoderHeight == height {
      // A session that has stopped accepting work is not reusable, and feeding it anyway is how an
      // NDI recording came to stop after a minute in silence: submissions kept succeeding, the
      // encoder produced nothing, and because every archive file opens on a sync sample the writer
      // had nothing to open the next one with. Rebuilding costs one keyframe.
      guard !existing.needsRebuild else {
        stats.archiveEncoderRebuilds += 1
        lock.unlock()
        return rebuildEncoder(width: width, height: height, rate: rate)
      }
      lock.unlock()
      return existing
    }
    lock.unlock()
    return rebuildEncoder(width: width, height: height, rate: rate)
  }

  private func rebuildEncoder(width: Int, height: Int, rate: Double) -> WireVideoEncoder? {
    lock.lock()
    let hadEncoder = videoEncoder != nil
    let settings = archiveEncoding
    let previous = videoEncoder
    archiveRefusalsCarried += previous?.refusedFrames ?? 0
    videoEncoder = nil
    let wanted = running && isArchiving
    lock.unlock()

    previous?.finish()
    // A source that has stopped, or whose archive is off, retires the old encoder and builds
    // nothing: a `stop` racing an encode would otherwise pay for a 1080p session to throw away.
    guard wanted else { return nil }

    guard let encoder = WireVideoEncoder(
      width: width,
      height: height,
      frameRate: rate,
      codec: settings.codec == .h264 ? .h264 : .hevc,
      bitrate: settings.bitrate,
      keyframeSeconds: settings.keyframeSeconds
    ) else {
      lock.lock()
      // Sticky, like `archiveRefused`: the next frame's format update would otherwise overwrite
      // this with nothing and the operator would never see it.
      encoderUnavailable = true
      stats.status = Self.encoderUnavailableReason
      lock.unlock()
      return nil
    }
    encoder.setHandler { [weak self] unit in self?.publish(unit) }

    lock.lock()
    // Building takes long enough for the source to have been stopped or its archive turned off
    // meanwhile; an encoder installed now would be a live 1080p session held by a source that is
    // recording nothing, until deinit tears it down — which is the window this class must not be
    // in. Retire it here instead, on the queue that owns encoding.
    guard running, isArchiving else {
      lock.unlock()
      encoder.finish()
      return nil
    }
    encoderUnavailable = false
    videoEncoder = encoder
    encoderWidth = width
    encoderHeight = height
    encoderRate = rate
    lock.unlock()

    // Only a *change* is a format change. The first encoder is not one, and reporting it as such
    // would make every recording start by tearing down the writer it had just built.
    if hadEncoder { onFormatChange?(sourceID) }
    return encoder
  }

  private func publish(_ unit: WireVideoEncoder.Unit) {
    lock.lock()
    let handler = sinks.compressed
    let codec = encodeCodec
    let pending = pendingFrames.removeValue(forKey: unit.presentationTime.value)
    if unit.isKeyframe { stats.archiveKeyframes += 1 }
    lock.unlock()
    guard let handler else { return }

    handler(CompressedFrame(
      sourceID: sourceID,
      codec: codec,
      data: unit.data,
      parameterSets: unit.parameterSets,
      isKeyframe: unit.isKeyframe,
      presentationTime: unit.presentationTime,
      decodeTime: .invalid,
      wallClock: clock.now,
      captureWallClock: pending?.captureWallClock,
      frameID: pending?.frameID ?? 0
    ))
  }

  // MARK: - Audio

  private func receiveAudio() {
    while true {
      lock.lock()
      let receiver = self.receiver
      let running = self.running
      lock.unlock()
      guard running, let receiver else { return }

      var audio = NDIlib_audio_frame_v3_t()
      var metadata = NDIlib_metadata_frame_t()
      let type = NDIlib_recv_capture_v3(receiver, nil, &audio, &metadata, 100)

      switch type {
      case NDIlib_frame_type_audio:
        handle(audio: audio)
        NDIlib_recv_free_audio_v3(receiver, &audio)

      case NDIlib_frame_type_metadata:
        handle(metadata: metadata)
        NDIlib_recv_free_metadata(receiver, &metadata)

      default:
        break
      }

      pollPerformance()
    }
  }

  private func handle(audio frame: NDIlib_audio_frame_v3_t) {
    if let rejection = NDIFrameValidator.accept(frame) {
      lock.lock()
      rejections.record(rejection)
      lock.unlock()
      return
    }
    guard let samples = audioConverter.convert(frame), !samples.isEmpty else { return }

    lock.lock()
    let sinks = self.sinks
    let format = audioFormat
    let start = audioSampleIndex
    audioSampleIndex += Int64(samples.count)
    let encoder = audioEncoder
    let isArchiving = self.isArchiving
    lock.unlock()

    if sinks.audio != nil || sinks.recordingAudio != nil, let format {
      let time = receiveClock.audioPresentationTime(
        sampleIndex: start,
        sampleRate: NDIAudioFrameConverter.outputSampleRate
      )
      if let buffer = AudioSampleBuilder.makeSampleBuffer(
        samples: samples,
        formatDescription: format,
        presentationTime: time
      ) {
        // Placed at its arrival for the screen and the recording alike: an NDI source's sound
        // waits in no delay line, and carries no capture time of its own.
        let frame = AudioFrame(sourceID: sourceID, sampleBuffer: buffer, wallClock: clock.now)
        sinks.audio?(frame)
        sinks.recordingAudio?(frame)
      }
    }

    guard isArchiving, let handler = sinks.compressedAudio, let encoder else { return }
    for packet in encoder.encode(samples) {
      handler(CompressedAudioFrame(
        sourceID: sourceID,
        data: packet.data,
        magicCookie: encoder.magicCookie,
        sampleRate: encoder.sampleRate,
        channelCount: encoder.channelCount,
        presentationTime: CMTime(
          value: packet.startFrame,
          timescale: CMTimeScale(encoder.sampleRate)
        ),
        wallClock: clock.now
      ))
    }
  }

  /// Metadata is never allowed to fail a frame.
  ///
  /// The SDK documentation is explicit: senders do send malformed XML, and a receiver has to
  /// tolerate it. So this counts and moves on rather than parsing defensively in five places.
  private func handle(metadata frame: NDIlib_metadata_frame_t) {
    guard let raw = frame.p_data else { return }
    let string = String(cString: raw)
    guard NDIFrameValidator.isWellFormedXML(string) else {
      lock.lock()
      rejections.malformedMetadata += 1
      lock.unlock()
      return
    }
  }

  // MARK: - Telemetry

  private func updateFormat(width: Int, height: Int, rate: Double, fourCC: NDIlib_FourCC_video_type_e) {
    lock.lock()
    defer { lock.unlock() }
    let format = SourceFormat(
      width: width,
      height: height,
      frameRate: rate,
      pixelFormat: NDIVideoFrameConverter.pixelFormat(for: fourCC) ?? 0,
      // What the *wire* carried, which under NDI is a pixel layout rather than a codec: libndi
      // decoded whatever the camera actually compressed with before we saw a frame. The archive's
      // codec is ours, and is reported separately.
      //
      // NDI stores its FourCCs little-endian, so the raw value reads backwards ("YVYU" for UYVY)
      // unless it is swapped first.
      codecName: "NDI \(SourceFormat.fourCharacterCode(OSType(bitPattern: Int32(fourCC.rawValue)).byteSwapped))"
    )
    if currentFormat != format { currentFormat = format }
    // A healthy frame clears a *receive* complaint, but not the archive refusal: that camera is
    // receiving perfectly and still not recording, which is exactly the state the operator has to
    // be told about and the one a cleared status would hide.
    stats.status = archiveRefused
      ? Self.archiveRefusedReason
      : (encoderUnavailable ? Self.encoderUnavailableReason : nil)
  }

  /// One string, so the refusal reads the same whether it is set when the archive is asked for or
  /// restored by the next good frame.
  private static let archiveRefusedReason =
    "no encoder left for this camera's archive; it is still live"


  private func record(waiting: TimeInterval, delivering: TimeInterval) {
    lock.lock()
    stats.waitingSeconds += waiting
    stats.deliverySeconds += delivering
    stats.deliverMaxMilliseconds = max(stats.deliverMaxMilliseconds, delivering * 1_000)
    lock.unlock()
  }

  private func refreshConnections() {
    lock.lock()
    let receiver = self.receiver
    lock.unlock()
    guard let receiver else { return }
    let count = Int(NDIlib_recv_get_no_connections(receiver))
    lock.lock()
    upstreamConnections = count
    lock.unlock()
  }

  /// The SDK's own answer to "did we lose anything?".
  ///
  /// `recv_get_performance` counts frames the receiver could not dequeue fast enough — our
  /// slowness rather than the network's, but a frame the operator did not get either way, so it
  /// lands in `packetsLost`. The SDK's queue depth is deliberately not read: `playoutDepth` is the
  /// delay line's, and the two were overwriting each other.
  private func pollPerformance() {
    lock.lock()
    let receiver = self.receiver
    lock.unlock()
    guard let receiver else { return }

    var total = NDIlib_recv_performance_t()
    var dropped = NDIlib_recv_performance_t()
    NDIlib_recv_get_performance(receiver, &total, &dropped)

    lock.lock()
    // Deltas, not the raw value: the SDK's counters reset when a receiver reconnects, and taking
    // them absolutely would make a reconnect look like the drop count going backwards.
    let droppedNow = dropped.video_frames + dropped.audio_frames
    if droppedNow >= lastPerformanceDropped {
      stats.packetsLost += UInt64(droppedNow - lastPerformanceDropped)
    }
    lastPerformanceDropped = droppedNow
    lock.unlock()
  }
}
