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
  private let clock: DirectorClock
  private let encodeCodec: CompressedFrame.Codec
  private let encodeBitrate: Int
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
  private var videoThread: Thread?
  private var audioThread: Thread?
  private var running = false
  private var sinks = FrameSinks()

  /// Nothing is encoded until the router says an archive is reading. Four idle preview tiles
  /// holding four 1080p encode sessions is how this app runs out of the only resource it has too
  /// few of.
  private var isArchiving = false
  /// Set when the archive was asked for but the encode budget had no room. The camera still
  /// previews and still cuts to programme; only its own recording is refused, which is the existing
  /// rule for starting a recording applied one level down.
  private var archiveRefused = false
  private var decimator = ArchiveDecimator()
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
    encodeCodec: CompressedFrame.Codec = .hevc,
    encodeBitrate: Int = 12_000_000,
    lowBandwidth: Bool = false,
    clock: DirectorClock = SystemClock()
  ) {
    self.sourceID = sourceID
    self.displayName = displayName
    self.ndiName = ndiName
    self.encodeCodec = encodeCodec
    self.encodeBitrate = encodeBitrate
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
    snapshot.decodeSessions = videoEncoder == nil ? 0 : 1
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

    let created: NDIlib_recv_instance_t? = ndiName.withCString { name in
      "GS Director".withCString { receiverName in
        var source = NDIlib_source_t()
        source.p_ndi_name = name
        source.p_url_address = nil

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

    guard let created else {
      NDIRuntime.shared.release()
      lock.unlock()
      throw FrameSourceError.failedToStart("could not create an NDI receiver for \(ndiName)")
    }
    receiver = created
    self.sinks = sinks
    running = true
    receiveClock.reset()
    audioConverter.reset()
    audioSampleIndex = 0
    audioFormat = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description()
    )

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
    let video = Thread { [weak self] in self?.receiveVideo() }
    video.name = "co.gamestation.director.ndi.video.\(sourceID.slug)"
    video.qualityOfService = .userInitiated

    let audio = Thread { [weak self] in self?.receiveAudio() }
    audio.name = "co.gamestation.director.ndi.audio.\(sourceID.slug)"
    audio.qualityOfService = .userInitiated

    lock.lock()
    videoThread = video
    audioThread = audio
    lock.unlock()

    video.start()
    audio.start()
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
    } else {
      self.isArchiving = false
      archiveRefused = false
      NDIArchiveBudget.shared.release(sourceID.rawValue)
      // The video encoder is dropped here and rebuilt on the first archived frame, so the session
      // is genuinely returned rather than parked. Rebuilding costs one frame at the start of a
      // recording, which is a keyframe anyway.
      videoEncoder = nil
      audioEncoder = nil
      encoderWidth = 0
      encoderHeight = 0
      pendingFrames.removeAll()
      decimator.reset()
    }
    lock.unlock()
    if !isArchiving { previousVideo?.finish() }
  }

  public func stop() {
    lock.lock()
    guard running else {
      lock.unlock()
      return
    }
    running = false
    isArchiving = false
    let receiver = self.receiver
    let encoder = videoEncoder
    self.receiver = nil
    videoEncoder = nil
    audioEncoder = nil
    videoThread = nil
    audioThread = nil
    pendingFrames.removeAll()
    sinks = FrameSinks()
    upstreamConnections = 0
    lock.unlock()

    // The capture loops are inside `NDIlib_recv_capture_v3` with a 100 ms timeout, so they see
    // `running == false` within that. Destroying the receiver under them would free the instance
    // they are still holding.
    encoder?.finish()
    if let receiver {
      Thread.sleep(forTimeInterval: 0.2)
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

    guard let timing = receiveClock.timing(for: frame) else { return }

    let width = Int(frame.xres)
    let height = Int(frame.yres)
    let rate = Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
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
    sinks.pixel?(PixelFrame(
      sourceID: sourceID,
      pixelBuffer: pixelBuffer,
      presentationTime: timing.presentationTime,
      wallClock: clock.now,
      frameID: timing.frameID
    ))
    let publishElapsed = Date().timeIntervalSince(publishStarted) * 1_000

    lock.lock()
    stats.copyMilliseconds += (copyElapsed - stats.copyMilliseconds) * 0.1
    stats.publishMilliseconds += (publishElapsed - stats.publishMilliseconds) * 0.1
    lock.unlock()

    lock.lock()
    let wantsArchive = isArchiving && sinks.compressed != nil
    lock.unlock()
    guard wantsArchive else { return }

    lock.lock()
    // Decimation ahead of the queue, not behind it: thinning deliberately gives a continuous
    // half-rate recording, where letting the queue overflow gives a recording missing two frames
    // in three at unpredictable moments. Both cost the same CPU; only one is a usable angle.
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
    encodeBacklog += 1
    stats.archiveBacklog = encodeBacklog
    pendingFrames[timing.presentationTime.value] = PendingFrame(
      frameID: timing.frameID,
      captureWallClock: timing.captureWallClock
    )
    // Bounded so a stalled encoder cannot grow this without limit. Two seconds of 60 fps is far
    // more slack than the encoder ever needs, and the oldest entry is the one whose frame is least
    // likely still to be in flight.
    while pendingFrames.count > 128, let oldest = pendingFrames.keys.min() {
      pendingFrames.removeValue(forKey: oldest)
    }
    lock.unlock()

    encodeQueue.async { [weak self] in
      guard let self else { return }
      let encoder = self.encoderForArchive(width: width, height: height, rate: rate)
      // Decimation changes the rate the encoder is actually fed, and VideoToolbox reckons its
      // keyframe interval against the rate it was told. Without this a decimated archive's
      // segments stretch past three seconds and stop matching every other source's — measured at
      // 7.4 s for a stride-4 HEVC archive that should have been cutting at 3.
      encoder?.setExpectedFrameRate(rate / Double(max(1, stride)))
      encoder?.encode(
        pixelBuffer,
        presentationTime: timing.presentationTime,
        duration: timing.duration
      )
      self.lock.lock()
      self.encodeBacklog -= 1
      self.stats.archiveBacklog = self.encodeBacklog
      self.stats.archiveEncoded += 1
      self.lock.unlock()
    }
  }

  /// Creates the archive encoder on first need, and replaces it when the camera's geometry moves.
  ///
  /// Deferred rather than made in `start` because an encoder is the scarce resource here: a camera
  /// that is only being previewed should not hold one, and four idle tiles holding four sessions is
  /// the difference between recording five cameras and recording one.
  private func encoderForArchive(width: Int, height: Int, rate: Double) -> WireVideoEncoder? {
    lock.lock()
    if let existing = videoEncoder, encoderWidth == width, encoderHeight == height {
      lock.unlock()
      return existing
    }
    let hadEncoder = videoEncoder != nil
    let previous = videoEncoder
    videoEncoder = nil
    lock.unlock()

    previous?.finish()

    guard let encoder = WireVideoEncoder(
      width: width,
      height: height,
      frameRate: rate,
      codec: encodeCodec,
      bitrate: encodeBitrate
    ) else {
      lock.lock()
      stats.status = "no encoder available for this camera's archive"
      lock.unlock()
      return nil
    }
    encoder.setHandler { [weak self] unit in self?.publish(unit) }

    lock.lock()
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
    let pending = pendingFrames.removeValue(forKey: unit.presentationTime.value)
    lock.unlock()
    guard let handler else { return }

    handler(CompressedFrame(
      sourceID: sourceID,
      codec: encodeCodec,
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

    if let handler = sinks.audio, let format {
      let time = receiveClock.audioPresentationTime(
        sampleIndex: start,
        sampleRate: NDIAudioFrameConverter.outputSampleRate
      )
      if let buffer = AudioSampleBuilder.makeSampleBuffer(
        samples: samples,
        formatDescription: format,
        presentationTime: time
      ) {
        handler(AudioFrame(sourceID: sourceID, sampleBuffer: buffer, wallClock: clock.now))
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
    stats.status = archiveRefused ? Self.archiveRefusedReason : nil
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

  /// The SDK's own answer to "did we lose anything, and was it us?".
  ///
  /// `recv_get_performance` counts frames the receiver could not dequeue fast enough — our
  /// slowness, not the network's — while `recv_get_queue` says how much is waiting right now. They
  /// are reported separately from `packetsLost` for that reason: mixing them would put our own
  /// backlog in the column an operator reads as a network fault.
  private func pollPerformance() {
    lock.lock()
    let receiver = self.receiver
    lock.unlock()
    guard let receiver else { return }

    var total = NDIlib_recv_performance_t()
    var dropped = NDIlib_recv_performance_t()
    NDIlib_recv_get_performance(receiver, &total, &dropped)

    var queue = NDIlib_recv_queue_t()
    NDIlib_recv_get_queue(receiver, &queue)

    lock.lock()
    // Deltas, not the raw value: the SDK's counters reset when a receiver reconnects, and taking
    // them absolutely would make a reconnect look like the drop count going backwards.
    let droppedNow = dropped.video_frames + dropped.audio_frames
    if droppedNow >= lastPerformanceDropped {
      stats.packetsLost += UInt64(droppedNow - lastPerformanceDropped)
    }
    lastPerformanceDropped = droppedNow
    stats.playoutDepth = Int(queue.video_frames)
    lock.unlock()
  }
}
