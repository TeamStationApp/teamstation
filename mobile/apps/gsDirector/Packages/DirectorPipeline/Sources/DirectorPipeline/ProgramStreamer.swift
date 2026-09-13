import AudioToolbox
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import DirectorCore
import DirectorRTMP
import DirectorSources

/// Encodes the programme composite to H.264 + AAC and publishes it over RTMP.
///
/// Recording still uses `ProgramEncoder` (AVAssetWriter, possibly HEVC). This session is a
/// second encode because classic RTMP/FLV only carries AVC. The two can run at once.
public final class ProgramStreamer: @unchecked Sendable {
  public struct Metrics: Sendable, Equatable {
    public var megabitsPerSecond: Double = 0
    public var droppedPackets: UInt64 = 0
    /// Bytes queued between this encoder and the socket.
    public var queuedBytes = 0
  }

  public typealias FailureHandler = @Sendable (String) -> Void

  private let telemetry: PipelineTelemetry
  private let converter: PixelConverter
  private let lock = NSLock()
  private var width = 1920
  private var height = 1080
  private var bitrate = 12_000_000
  private var frameRate = 30
  private var gopSeconds = 2.0
  private var client: RTMPClient?
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
    lock.unlock()
    let raw = client?.metrics ?? .init()
    return Metrics(
      megabitsPerSecond: raw.megabitsPerSecond,
      droppedPackets: raw.droppedPackets,
      queuedBytes: raw.queuedBytes
    )
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
    // How far behind the socket may fall before the client sheds media, in the encoder's own
    // terms: about a second of what this session is actually producing.
    client.configure(sendBudgetBytes: RTMPClient.sendBudget(forBitrate: config.programBitrate))
    client.onFailure { [weak self] error in
      self?.handleFailure(error.description)
    }
    markStarted(client)
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
    width = config.programResolution.width
    height = config.programResolution.height
    bitrate = config.programBitrate
    frameRate = config.programFrameRate
    gopSeconds = config.gopSeconds
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

  /// Next encoded frame must be an IDR. Cuts and replay otherwise feed mid-GOP P-frames to HLS.
  public func requestKeyframe() {
    lock.lock()
    clock.requestKeyframe()
    lock.unlock()
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
    pendingEncodes = 0
    lock.unlock()
    timer?.cancel()
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

    let isEncodable =
      CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      && CVPixelBufferGetWidth(pixelBuffer) == width
      && CVPixelBufferGetHeight(pixelBuffer) == height
    let encodable = isEncodable
      ? pixelBuffer
      : converter.convert(pixelBuffer: pixelBuffer, width: width, height: height)
    guard let encodable else {
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
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: kCMVideoCodecType_H264,
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
      throw ProgramStreamerError.encoderUnavailable(status)
    }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ProfileLevel,
      value: kVTProfileLevel_H264_Baseline_AutoLevel
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: bitrate as CFNumber
    )
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
      value: clock.maxKeyFrameInterval as CFNumber
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
    let keyframe = Self.payloadContainsIDR(payload) || isKeyframe(encoded)
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
      let bitrate = self.bitrate
      lock.unlock()
      client.sendMetadata(width: width, height: height, frameRate: frameRate, bitrate: bitrate)
      lock.lock()
    }
    if !sentVideoConfig {
      guard keyframe,
        let format = CMSampleBufferGetFormatDescription(encoded),
        let record = Self.avcRecord(from: format)
      else {
        lock.unlock()
        return
      }
      sentVideoConfig = true
      lock.unlock()
      client.sendVideo(timestampMs: timestamp, tag: FLVTag.video(keyframe: true, packetType: 0, payload: record))
    } else {
      lock.unlock()
    }
    let outcome = client.sendVideo(
      timestampMs: timestamp,
      tag: FLVTag.video(keyframe: keyframe, packetType: 1, payload: payload)
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

  /// AVCC length-prefixed NAL units. Type 5 is an IDR, which is what ffmpeg splits HLS on.
  public static func payloadContainsIDR(_ payload: Data) -> Bool {
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
      let nalType = payload[offset] & 0x1F
      if nalType == 5 { return true }
      offset += length
    }
    return false
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
  case encoderUnavailable(OSStatus)

  public var description: String {
    switch self {
    case let .encoderUnavailable(status): "could not start the stream encoder (\(status))"
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
