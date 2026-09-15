import AdaptiveBitrate
import AudioToolbox
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import DirectorCore
import DirectorRTMP
import DirectorSources

/// Encodes the programme composite with the stream's own settings and publishes it over RTMP.
///
/// Recording still uses `ProgramEncoder` (AVAssetWriter). This is a second encode, with its own
/// group in Settings — codec, resolution, frame rate and a low and high bitrate — because what suits
/// a master on disk and what suits an uplink are different things. The two can run at once.
///
/// H.265 goes out in Enhanced RTMP, H.264 in classic FLV with the Baseline profile it always used.
/// A composite of another size is scaled to the stream's, keeping its shape and letterboxing when the
/// shapes differ.
///
/// The bitrate starts at the high end of the operator's range and moves inside it with the uplink:
/// the adaptive bitrate controller GS Cameraman uses, fed from the RTMP client's own send queue.
public final class ProgramStreamer: @unchecked Sendable {
  public struct Metrics: Sendable, Equatable {
    public var megabitsPerSecond: Double = 0
    public var droppedPackets: UInt64 = 0
    /// Bytes queued between this encoder and the socket.
    public var queuedBytes = 0
    /// The bitrate controller, as it last decided.
    public var rate = StreamRateTelemetry()
  }

  public typealias FailureHandler = @Sendable (String) -> Void

  private let telemetry: PipelineTelemetry
  private let converter: PixelConverter
  private let lock = NSLock()
  private var width = 1920
  private var height = 1080
  private var codec = RTMPVideoCodec.hevc
  /// The stream's range. It starts at the high bitrate.
  private var bitrateLow = 2_000_000
  private var bitrateHigh = 6_000_000
  /// What the encoder has been told, which is where a rebuilt session starts too.
  private var bitrate = 6_000_000
  private var frameRate = 30
  private var gopSeconds = 2.0
  private var client: RTMPClient?
  /// Moves the bitrate between the low and high settings; runs from `start` to `stop`.
  private var rateLoop: AdaptiveBitrateLoop?
  private var session: VTCompressionSession?
  private var aac = AACPacketizer()
  private var isRunning = false
  private var sentVideoConfig = false
  private var sentAudioConfig = false
  private var sentMetadata = false
  private var clock = StreamEncodeClock()
  /// When this stream started, so the watchdog can tell "no keyframe yet" from "no keyframe for a
  /// while". Zero until `start`.
  private var streamStartWall: CFAbsoluteTime = 0
  /// When the encoder last handed back a real picture, as opposed to a callback carrying an error.
  private var lastOutputWall: CFAbsoluteTime = 0
  /// Holds the encoder to the stream's own frame rate; see `StreamFramePacer`.
  private var pacer = StreamFramePacer(frameRate: 30)
  private var onFailure: FailureHandler?
  /// VideoToolbox keeps each submitted pixel buffer until the encode callback. Without a cap,
  /// a slow RTMP ingest lets that queue grow without bound at programme frame rate.
  private var pendingEncodes = 0
  private static let maximumPendingEncodes = 3
  /// One reserved in-flight slot so a GOP-due IDR is not blocked by three dropped P-frames.
  private static let idleIDRPendingCap = 4
  private let gopQueue = DispatchQueue(label: "co.gamestation.director.stream.gop")
  private var gopTimer: DispatchSourceTimer?
  private var lastEncodable: CVPixelBuffer?
  private var lastCallbackWall: CFAbsoluteTime = 0
  private var lastProgramFrameWall: CFAbsoluteTime = 0
  private var lastResetWall: CFAbsoluteTime = 0

  public init(telemetry: PipelineTelemetry, converter: PixelConverter) {
    self.telemetry = telemetry
    self.converter = converter
  }

  public var running: Bool {
    lock.lock()
    defer { lock.unlock() }
    return isRunning
  }

  public var metrics: Metrics {
    lock.lock()
    let client = self.client
    let loop = rateLoop
    let codec = self.codec
    lock.unlock()
    let raw = client?.metrics ?? .init()
    return Metrics(
      megabitsPerSecond: raw.megabitsPerSecond,
      droppedPackets: raw.droppedPackets,
      queuedBytes: raw.queuedBytes,
      rate: loop.map { Self.rateTelemetry($0.status.controller, codec: codec) } ?? StreamRateTelemetry()
    )
  }

  static func rateTelemetry(_ status: AdaptiveBitrateController.Status, codec: RTMPVideoCodec) -> StreamRateTelemetry {
    var rate = StreamRateTelemetry()
    rate.codec = codec.rawValue
    rate.bitrate = status.bitrate
    rate.low = status.floor
    rate.high = status.ceiling
    rate.lastDecision = status.lastDecision.rawValue
    rate.queueMilliseconds = status.queueDelayMilliseconds
    rate.deliveryBitsPerSecond = status.deliveryBitsPerSecond ?? 0
    rate.transportBaseMilliseconds = status.transportBaseMilliseconds
    rate.decreases = status.decreases
    rate.increases = status.increases
    return rate
  }

  public func start(urlString: String, config: AppConfig, onFailure: FailureHandler?) async throws {
    let parsed = RTMPURL.parse(urlString)
    let url: RTMPURL
    switch parsed {
    case let .success(value): url = value
    case let .failure(error): throw error
    }

    guard beginStart(config: config, onFailure: onFailure) else { return }

    try openEncoder()
    let client = RTMPClient()
    // How far behind the socket may fall before the client sheds media: about a second of the top
    // of the stream's range, which is the most this session ever produces.
    client.configure(
      sendBudgetBytes: RTMPClient.sendBudget(forBitrate: config.streamBitrateHigh),
      videoCodec: Self.rtmpCodec(config.streamCodec)
    )
    client.onFailure { [weak self] error in
      self?.handleFailure(error.description)
    }
    markStarted(client)
    startRateLoop(client: client)
    telemetry.recordEncodeSessionChange(delta: 1)
    do {
      try await client.publish(to: url)
    } catch {
      stop()
      throw error
    }
  }

  /// NSLock cannot be taken inside an async function; these two helpers keep `start` legal.
  private func beginStart(config: AppConfig, onFailure: FailureHandler?) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if isRunning { return false }
    applyStreamSettings(config)
    self.onFailure = onFailure
    sentVideoConfig = false
    sentAudioConfig = false
    sentMetadata = false
    clock = StreamEncodeClock(frameRate: frameRate, gopSeconds: gopSeconds)
    pacer = StreamFramePacer(frameRate: frameRate)
    aac.reset()
    lastEncodable = nil
    lastCallbackWall = 0
    lastProgramFrameWall = 0
    lastResetWall = 0
    streamStartWall = CFAbsoluteTimeGetCurrent()
    lastOutputWall = 0
    pendingEncodes = 0
    return true
  }

  /// The stream group of Settings, and the keyframe interval every encoder shares.
  private func applyStreamSettings(_ config: AppConfig) {
    width = config.streamResolution.width
    height = config.streamResolution.height
    codec = Self.rtmpCodec(config.streamCodec)
    bitrateLow = config.streamBitrateLow
    bitrateHigh = config.streamBitrateHigh
    bitrate = config.streamBitrateHigh
    frameRate = max(1, config.streamFrameRate)
    gopSeconds = config.gopSeconds
  }

  static func rtmpCodec(_ codec: ProgramCodec) -> RTMPVideoCodec {
    switch codec {
    case .h264: .h264
    case .hevc: .hevc
    }
  }

  /// Next encoded frame must be an IDR. Cuts and replay otherwise feed mid-GOP P-frames to HLS.
  public func requestKeyframe() {
    lock.lock()
    clock.requestKeyframe()
    lock.unlock()
  }

  /// Starts the controller at the high bitrate, which is where the session already is. Until the
  /// publish is live there is no link to judge, and the controller holds.
  private func startRateLoop(client: RTMPClient) {
    lock.lock()
    let high = bitrateHigh
    let low = bitrateLow
    lock.unlock()
    let loop = AdaptiveBitrateLoop(
      ceiling: high,
      floor: low,
      tuning: RTMPClient.adaptiveBitrateTuning,
      sample: { [weak client] reply in
        guard let client, client.isLive else {
          reply(nil)
          return
        }
        reply(client.congestionSample())
      },
      apply: { [weak self] rate in self?.applyBitrate(rate) }
    )
    lock.lock()
    rateLoop = loop
    lock.unlock()
    loop.configure(ceiling: high, floor: low, enabled: true)
  }

  /// A rate from the controller, onto the live session: the next frame is coded at it. A session
  /// the watchdog rebuilds later opens at the same rate.
  private func applyBitrate(_ rate: Int) {
    lock.lock()
    guard isRunning else {
      lock.unlock()
      return
    }
    bitrate = rate
    let session = self.session
    lock.unlock()
    if let session { Self.setRate(rate, on: session) }
  }

  private func markStarted(_ client: RTMPClient) {
    lock.lock()
    self.client = client
    isRunning = true
    lock.unlock()
    startGOPWatchdog()
  }

  public func stop() {
    lock.lock()
    let running = isRunning
    isRunning = false
    let timer = gopTimer
    gopTimer = nil
    lastEncodable = nil
    let session = self.session
    self.session = nil
    let client = self.client
    self.client = nil
    let loop = rateLoop
    rateLoop = nil
    pendingEncodes = 0
    lock.unlock()
    timer?.cancel()
    loop?.stop()
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }
    client?.stop()
    if running { telemetry.recordEncodeSessionChange(delta: -1) }
  }

  public func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
    lock.lock()
    let admitted = pacer.admit(now: CFAbsoluteTimeGetCurrent())
    lock.unlock()
    guard admitted else { return }
    encode(pixelBuffer, sourceTime: presentationTime, forceKey: nil, isIdle: false)
  }

  /// What `start` would configure the stream as, without opening an encoder or a socket.
  struct Configuration: Equatable {
    var width: Int
    var height: Int
    var codec: RTMPVideoCodec
    var frameRate: Int
    var bitrate: Int
    var bitrateLow: Int
    var bitrateHigh: Int
    var gopSeconds: Double
  }

  func configurationForTesting(_ config: AppConfig) -> Configuration {
    lock.lock()
    defer { lock.unlock() }
    applyStreamSettings(config)
    return Configuration(
      width: width,
      height: height,
      codec: codec,
      frameRate: frameRate,
      bitrate: bitrate,
      bitrateLow: bitrateLow,
      bitrateHigh: bitrateHigh,
      gopSeconds: gopSeconds
    )
  }

  var pendingEncodesForTesting: Int {
    lock.lock()
    defer { lock.unlock() }
    return pendingEncodes
  }

  func simulateOutputCallbackForTesting(
    incrementPending: Bool,
    sample: CMSampleBuffer?,
    status: OSStatus,
    flags: VTEncodeInfoFlags = []
  ) {
    if incrementPending {
      lock.lock()
      pendingEncodes += 1
      lock.unlock()
    }
    didEncode(sample: sample, status: status, flags: flags)
  }

  private func encode(
    _ pixelBuffer: CVPixelBuffer,
    sourceTime: CMTime,
    forceKey: Bool?,
    isIdle: Bool
  ) {
    lock.lock()
    guard isRunning, let session else {
      lock.unlock()
      return
    }
    let now = CFAbsoluteTimeGetCurrent()
    if !isIdle {
      lastProgramFrameWall = now
      telemetry.recordProgramFrameAge(0)
    }
    let time = clock.nextPresentationTime(source: sourceTime, now: now)
    let mustKey = forceKey ?? (clock.shouldForceKey(at: time, now: now) || !sentVideoConfig || isIdle)
    telemetry.recordStreamKeyframeAge(clock.keyframeAgeSeconds(now: now))
    let cap = mustKey ? Self.idleIDRPendingCap : Self.maximumPendingEncodes
    if pendingEncodes >= cap {
      // Dropped before the encoder saw it, so no reference is broken and no IDR is owed: the next
      // frame predicts from the last one encoded, and the GOP forces a keyframe on time anyway.
      // Asking for one here turned every backlog into a keyframe — measured in a soak at about 2.5
      // a second against a 2 s GOP's 0.5 — which makes each frame dearer exactly when the encoder
      // is already behind. Same reasoning as the over-budget drop below.
      telemetry.recordStreamPendingEncodes(pendingEncodes)
      lock.unlock()
      return
    }
    pendingEncodes += 1
    telemetry.recordStreamPendingEncodes(pendingEncodes)
    lock.unlock()

    guard let encodable = Self.streamPicture(pixelBuffer, width: width, height: height, converter: converter) else {
      lock.lock()
      pendingEncodes = max(0, pendingEncodes - 1)
      telemetry.recordStreamPendingEncodes(pendingEncodes)
      lock.unlock()
      return
    }

    let properties: CFDictionary? = mustKey
      ? [ kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue ] as CFDictionary
      : nil
    let status = VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: encodable,
      presentationTimeStamp: time,
      duration: CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1))),
      frameProperties: properties,
      sourceFrameRefcon: nil,
      infoFlagsOut: nil
    )
    if status != noErr {
      lock.lock()
      pendingEncodes = max(0, pendingEncodes - 1)
      telemetry.recordStreamPendingEncodes(pendingEncodes)
      telemetry.recordEncodeFailure(code: status)
      clock.requestKeyframe()
      lock.unlock()
      return
    }

    let copy = converter.convert(pixelBuffer: encodable, width: width, height: height)
    lock.lock()
    if let copy {
      lastEncodable = copy
    } else if !isIdle {
      lastEncodable = encodable
    }
    if isIdle {
      telemetry.recordStreamIdleKeyframe()
    }
    lock.unlock()
  }

  /// The picture at the stream's size in the encoder's format: passed through when it already is,
  /// converted when only the format differs, and otherwise scaled to fit with its shape kept.
  /// VideoToolbox's letterbox paints the bars black (measured: Y 16, CbCr 128), so a pooled buffer's
  /// last picture cannot show through them.
  static func streamPicture(
    _ pixelBuffer: CVPixelBuffer,
    width: Int,
    height: Int,
    converter: PixelConverter
  ) -> CVPixelBuffer? {
    let format = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    let sameSize = CVPixelBufferGetWidth(pixelBuffer) == width && CVPixelBufferGetHeight(pixelBuffer) == height
    if sameSize {
      return CVPixelBufferGetPixelFormatType(pixelBuffer) == format
        ? pixelBuffer
        : converter.convert(pixelBuffer: pixelBuffer, width: width, height: height)
    }
    return converter.scale(pixelBuffer, toWidth: width, height: height, format: format)
  }

  private func startGOPWatchdog() {
    lock.lock()
    let existing = gopTimer
    gopTimer = nil
    let interval = min(0.25, gopSeconds / 4)
    lock.unlock()
    existing?.cancel()

    let timer = DispatchSource.makeTimerSource(queue: gopQueue)
    timer.schedule(deadline: .now() + interval, repeating: interval)
    timer.setEventHandler { [weak self] in
      self?.gopWatchdogTick()
    }
    lock.lock()
    gopTimer = timer
    lock.unlock()
    timer.resume()
  }

  private func gopWatchdogTick() {
    lock.lock()
    guard isRunning else {
      lock.unlock()
      return
    }
    let now = CFAbsoluteTimeGetCurrent()
    telemetry.recordStreamKeyframeAge(clock.keyframeAgeSeconds(now: now))
    telemetry.recordStreamPendingEncodes(pendingEncodes)
    telemetry.recordStreamEncodeCallbackAge(
      lastCallbackWall > 0 ? max(0, now - lastCallbackWall) : 0
    )
    telemetry.recordProgramFrameAge(
      lastProgramFrameWall > 0 ? max(0, now - lastProgramFrameWall) : 0
    )
    let action = StreamStallPolicy(gopSeconds: gopSeconds).action(
      now: now,
      lastKeyframeWall: clock.lastKeyframeWall,
      lastCallbackWall: lastCallbackWall,
      pendingEncodes: pendingEncodes,
      hasLastFrame: lastEncodable != nil,
      lastResetWall: lastResetWall,
      startedWall: streamStartWall,
      lastOutputWall: lastOutputWall
    )
    let idleBuffer = lastEncodable
    lock.unlock()

    switch action {
    case .none:
      break
    case .resetSession:
      resetWedgedSession()
      if let idleBuffer {
        encode(idleBuffer, sourceTime: .invalid, forceKey: true, isIdle: true)
      }
    case .encodeIdleIDR:
      if let idleBuffer {
        encode(idleBuffer, sourceTime: .invalid, forceKey: true, isIdle: true)
      }
    }
  }

  private func resetWedgedSession() {
    lock.lock()
    guard isRunning else {
      lock.unlock()
      return
    }
    let old = session
    session = nil
    pendingEncodes = 0
    sentVideoConfig = false
    clock.requestKeyframe()
    lastResetWall = CFAbsoluteTimeGetCurrent()
    telemetry.recordStreamPendingEncodes(0)
    telemetry.recordStreamEncoderReset()
    lock.unlock()
    if let old {
      VTCompressionSessionInvalidate(old)
    }
    do {
      try openEncoder()
    } catch {
      handleFailure(String(describing: error))
    }
  }

  public func append(audio frame: AudioFrame) {
    lock.lock()
    guard isRunning, let client, client.isLive else {
      lock.unlock()
      return
    }
    let packets = aac.encode(frame.sampleBuffer)
    let cookie = aac.audioSpecificConfig
    guard sentVideoConfig else {
      lock.unlock()
      return
    }
    let sentAudio = sentAudioConfig
    if !sentAudioConfig { sentAudioConfig = true }
    let now = CFAbsoluteTimeGetCurrent()
    if clock.startWall == 0 {
      lock.unlock()
      return
    }
    let audioTime = clock.timeNow(now: now)
    lock.unlock()

    let timestamp = milliseconds(audioTime)
    if !sentAudio {
      client.sendAudio(timestampMs: timestamp, tag: FLVTag.audio(packetType: 0, payload: cookie))
    }
    for packet in packets {
      client.sendAudio(timestampMs: timestamp, tag: FLVTag.audio(packetType: 1, payload: packet))
    }
  }

  private func openEncoder() throws {
    var session: VTCompressionSession?
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    lock.lock()
    let width = self.width
    let height = self.height
    let codec = self.codec
    let bitrate = self.bitrate
    let frameRate = self.frameRate
    let gopSeconds = self.gopSeconds
    let maxKeyFrameInterval = clock.maxKeyFrameInterval
    lock.unlock()
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
      encoderSpecification: [
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue
      ] as CFDictionary,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: { refcon, _, status, flags, sample in
        guard let refcon else { return }
        let streamer = Unmanaged<ProgramStreamer>.fromOpaque(refcon).takeUnretainedValue()
        streamer.didEncode(sample: sample, status: status, flags: flags)
      },
      refcon: refcon,
      compressionSessionOut: &session
    )
    guard status == noErr, let session else {
      throw ProgramStreamerError.encoderUnavailable(status, codec: codec)
    }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    // Main is what every Enhanced RTMP ingest decodes; Baseline stays H.264's profile because it is
    // what this stream has always sent, and every ingest takes it.
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ProfileLevel,
      value: codec == .hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_Baseline_AutoLevel
    )
    Self.setRate(bitrate, on: session)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ExpectedFrameRate,
      value: frameRate as CFNumber
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
      value: gopSeconds as CFNumber
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
      value: maxKeyFrameInterval as CFNumber
    )
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxFrameDelayCount,
      value: Self.maximumPendingEncodes as CFNumber
    )
    VTCompressionSessionPrepareToEncodeFrames(session)
    lock.lock()
    self.session = session
    lock.unlock()
  }

  /// How far above the average the encoder may go over any one second.
  ///
  /// `AverageBitRate` alone is a long-run target: VideoToolbox meets it over tens of seconds and lets
  /// a busy scene run well over it in the meantime, and a second at twice the rate is a second of
  /// queue on a link sized for the average. The limit keeps any one second within half as much again,
  /// which leaves room for the keyframe every GOP brings and still bounds what one second can put in
  /// the send queue.
  static let dataRateLimitFactor = 1.5

  /// `DataRateLimits` for `bitrate`: bytes per one-second window.
  static func dataRateLimits(forBitrate bitrate: Int) -> [Double] {
    [ (Double(bitrate) * dataRateLimitFactor / 8).rounded(), 1 ]
  }

  /// Gives a session a bitrate. Both properties are live, so this is also how a running session
  /// changes rate: the next frame is coded at the new one, with no new session and no keyframe.
  ///
  /// The status of `DataRateLimits` is not checked. The hardware encoders take it for both codecs,
  /// but a simulator's software HEVC encoder refuses it with -12900 (property not supported) and
  /// still honours `AverageBitRate`, which is the property the bitrate controller relies on.
  static func setRate(_ bitrate: Int, on session: VTCompressionSession) {
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: bitrate as CFNumber
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_DataRateLimits,
      value: dataRateLimits(forBitrate: bitrate) as CFArray
    )
  }

  private func didEncode(sample: CMSampleBuffer?, status: OSStatus, flags: VTEncodeInfoFlags) {
    lock.lock()
    pendingEncodes = max(0, pendingEncodes - 1)
    lastCallbackWall = CFAbsoluteTimeGetCurrent()
    telemetry.recordStreamPendingEncodes(pendingEncodes)
    telemetry.recordStreamEncodeCallbackAge(0)
    if status != noErr {
      telemetry.recordEncodeFailure(code: status)
      clock.requestKeyframe()
      lock.unlock()
      return
    }
    if sample == nil || flags.contains(.frameDropped) {
      clock.requestKeyframe()
      lock.unlock()
      return
    }
    let encoded = sample
    lastOutputWall = CFAbsoluteTimeGetCurrent()
    lock.unlock()
    guard let encoded, let dataBuffer = CMSampleBufferGetDataBuffer(encoded) else { return }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
      let pointer, length > 0
    else { return }
    let payload = Data(bytes: pointer, count: length)
    let timestamp = milliseconds(CMSampleBufferGetPresentationTimeStamp(encoded))
    lock.lock()
    let codec = self.codec
    lock.unlock()
    let keyframe = Self.payloadContainsIDR(payload, codec: codec) || isKeyframe(encoded)
    let now = CFAbsoluteTimeGetCurrent()

    lock.lock()
    if keyframe {
      clock.noteKeyframe(at: CMSampleBufferGetPresentationTimeStamp(encoded), now: now)
      telemetry.recordStreamKeyframe(ageSeconds: 0)
    } else {
      telemetry.recordStreamKeyframeAge(clock.keyframeAgeSeconds(now: now))
    }
    guard isRunning, let client, client.isLive else {
      lock.unlock()
      return
    }
    if !sentMetadata {
      sentMetadata = true
      let width = self.width
      let height = self.height
      let frameRate = self.frameRate
      let bitrate = self.bitrateHigh
      lock.unlock()
      client.sendMetadata(width: width, height: height, frameRate: frameRate, bitrate: bitrate)
      lock.lock()
    }
    if !sentVideoConfig {
      guard keyframe,
        let format = CMSampleBufferGetFormatDescription(encoded),
        let record = Self.decoderConfigurationRecord(from: format, codec: codec)
      else {
        lock.unlock()
        return
      }
      sentVideoConfig = true
      lock.unlock()
      client.sendVideo(timestampMs: timestamp, tag: FLVTag.videoSequenceHeader(codec: codec, record: record))
    } else {
      lock.unlock()
    }
    let outcome = client.sendVideo(
      timestampMs: timestamp,
      tag: FLVTag.videoFrame(codec: codec, keyframe: keyframe, payload: payload)
    )
    // Only when the client is waiting for a keyframe to resume on. Asking on every over-budget
    // drop would force an IDR per frame while the link is still saturated, which is the opposite
    // of shedding load.
    if outcome == .droppedAwaitingKeyframe {
      lock.lock()
      clock.requestKeyframe()
      lock.unlock()
    }
  }

  private func handleFailure(_ message: String) {
    stop()
    onFailure?(message)
  }

  private func milliseconds(_ time: CMTime) -> UInt32 {
    guard time.isNumeric else { return 0 }
    return UInt32(max(0, time.seconds * 1000))
  }

  private func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[CFString: Any]],
      let first = attachments.first
    else { return false }
    if let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool, notSync {
      return false
    }
    if let depends = first[kCMSampleAttachmentKey_DependsOnOthers] as? Bool {
      return !depends
    }
    return false
  }

  /// Length-prefixed NAL units. For H.264, type 5 is an IDR, which is what ffmpeg splits HLS on. For
  /// H.265 it is any IRAP picture, types 16 to 23 (BLA, IDR, CRA), each of which a decoder can start
  /// on.
  public static func payloadContainsIDR(_ payload: Data, codec: RTMPVideoCodec = .h264) -> Bool {
    var offset = 0
    while offset + 4 <= payload.count {
      let length = payload.withUnsafeBytes { raw -> Int in
        let base = raw.bindMemory(to: UInt8.self)
        return Int(base[offset]) << 24
          | Int(base[offset + 1]) << 16
          | Int(base[offset + 2]) << 8
          | Int(base[offset + 3])
      }
      offset += 4
      guard length > 0, offset + length <= payload.count else { return false }
      switch codec {
      case .h264:
        if payload[offset] & 0x1F == 5 { return true }
      case .hevc:
        if (16 ... 23).contains((payload[offset] >> 1) & 0x3F) { return true }
      }
      offset += length
    }
    return false
  }

  private static func decoderConfigurationRecord(from format: CMFormatDescription, codec: RTMPVideoCodec) -> Data? {
    switch codec {
    case .h264: avcRecord(from: format)
    case .hevc: hevcRecord(from: format)
    }
  }

  /// The VPS, SPS and PPS VideoToolbox put in the format description, as an `hvcC` record.
  private static func hevcRecord(from format: CMFormatDescription) -> Data? {
    var count = 0
    var nalLength: Int32 = 0
    guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
      format,
      parameterSetIndex: 0,
      parameterSetPointerOut: nil,
      parameterSetSizeOut: nil,
      parameterSetCountOut: &count,
      nalUnitHeaderLengthOut: &nalLength
    ) == noErr, count >= 3 else { return nil }
    var sets: [Data] = []
    for index in 0 ..< count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        format,
        parameterSetIndex: index,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: nil
      ) == noErr, let pointer else { return nil }
      sets.append(Data(bytes: pointer, count: size))
    }
    return HEVCDecoderConfiguration.record(parameterSets: sets, lengthSize: Int(nalLength))
  }

  private static func avcRecord(from format: CMFormatDescription) -> Data? {
    var count = 0
    var nalLength: Int32 = 0
    guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format,
      parameterSetIndex: 0,
      parameterSetPointerOut: nil,
      parameterSetSizeOut: nil,
      parameterSetCountOut: &count,
      nalUnitHeaderLengthOut: &nalLength
    ) == noErr, count >= 2 else { return nil }

    func parameterSet(at index: Int) -> Data? {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format,
        parameterSetIndex: index,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: nil
      ) == noErr, let pointer else { return nil }
      return Data(bytes: pointer, count: size)
    }

    guard let first = parameterSet(at: 0), let second = parameterSet(at: 1) else { return nil }
    let sps: Data
    let pps: Data
    if first.count > 0, (first[0] & 0x1F) == 7 {
      sps = first
      pps = second
    } else {
      sps = second
      pps = first
    }
    return FLVTag.avcDecoderConfigurationRecord(sps: sps, pps: pps)
  }
}

public enum ProgramStreamerError: Error, CustomStringConvertible {
  case encoderUnavailable(OSStatus, codec: RTMPVideoCodec)

  public var description: String {
    switch self {
    case let .encoderUnavailable(status, codec):
      "could not start the \(codec.displayName) stream encoder (\(status))"
    }
  }
}

/// Turns the programme mix (48 kHz stereo LPCM) into AAC-LC packets of 1024 frames.
final class AACPacketizer: @unchecked Sendable {
  private var converter: AudioConverterRef?
  private var leftover: [Int16] = []
  private(set) var audioSpecificConfig = Data([ 0x11, 0x90 ])
  private let channels = 2
  private let frameSamples = 1024

  func reset() {
    if let converter { AudioConverterDispose(converter) }
    converter = nil
    leftover.removeAll()
  }

  func encode(_ sampleBuffer: CMSampleBuffer) -> [Data] {
    guard let samples = Self.int16Samples(from: sampleBuffer) else { return [] }
    leftover.append(contentsOf: samples)
    ensureConverter()
    guard let converter else { return [] }

    var packets: [Data] = []
    let needed = frameSamples * channels
    while leftover.count >= needed {
      let frame = Array(leftover.prefix(needed))
      leftover.removeFirst(needed)
      if let packet = convert(frame, converter: converter) {
        packets.append(packet)
      }
    }
    return packets
  }

  private func ensureConverter() {
    if converter != nil { return }
    var input = AudioStreamBasicDescription(
      mSampleRate: 48_000,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 4,
      mFramesPerPacket: 1,
      mBytesPerFrame: 4,
      mChannelsPerFrame: 2,
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var output = AudioStreamBasicDescription(
      mSampleRate: 48_000,
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: 1024,
      mBytesPerFrame: 0,
      mChannelsPerFrame: 2,
      mBitsPerChannel: 0,
      mReserved: 0
    )
    var converter: AudioConverterRef?
    guard AudioConverterNew(&input, &output, &converter) == noErr, let converter else { return }
    var bitrate: UInt32 = 128_000
    AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate, 4, &bitrate)
    // FLV AAC packet type 0 is AudioSpecificConfig (2 bytes), not Apple's MP4 magic cookie.
    audioSpecificConfig = Data([ 0x11, 0x90 ])
    self.converter = converter
  }

  private func convert(_ frame: [Int16], converter: AudioConverterRef) -> Data? {
    var samples = frame
    var packet = [UInt8](repeating: 0, count: 2048)
    var ioPackets: UInt32 = 1
    var packetDesc = AudioStreamPacketDescription()
    var buffer = AudioBufferList(
      mNumberBuffers: 1,
      mBuffers: AudioBuffer(
        mNumberChannels: 2,
        mDataByteSize: UInt32(packet.count),
        mData: &packet
      )
    )
    var inputCount: UInt32 = UInt32(frameSamples)
    let status = samples.withUnsafeMutableBufferPointer { pointer in
      var userData = Input(samples: pointer.baseAddress, remaining: inputCount)
      return AudioConverterFillComplexBuffer(
        converter,
        { _, ioNumberDataPackets, ioData, _, userData in
          guard let userData else { return 1 }
          let input = userData.assumingMemoryBound(to: Input.self)
          let packets = min(ioNumberDataPackets.pointee, input.pointee.remaining)
          ioNumberDataPackets.pointee = packets
          ioData.pointee.mNumberBuffers = 1
          ioData.pointee.mBuffers.mNumberChannels = 2
          ioData.pointee.mBuffers.mDataByteSize = packets * 4
          ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(mutating: input.pointee.samples)
          input.pointee.remaining = 0
          return noErr
        },
        &userData,
        &ioPackets,
        &buffer,
        &packetDesc
      )
    }
    guard status == noErr, ioPackets > 0 else { return nil }
    let size = packetDesc.mDataByteSize > 0 ? Int(packetDesc.mDataByteSize) : Int(buffer.mBuffers.mDataByteSize)
    return Data(packet.prefix(size))
  }

  private static func int16Samples(from sampleBuffer: CMSampleBuffer) -> [Int16]? {
    guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(
      dataBuffer,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &length,
      dataPointerOut: &pointer
    ) == noErr, let pointer, length >= 2 else { return nil }
    let count = length / 2
    return (0 ..< count).map { offset in
      let bytes = UnsafeRawPointer(pointer).advanced(by: offset * 2)
      return bytes.loadUnaligned(as: Int16.self)
    }
  }

  private struct Input {
    var samples: UnsafeMutablePointer<Int16>?
    var remaining: UInt32
  }
}
