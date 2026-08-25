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
  private var onFailure: FailureHandler?
  /// VideoToolbox keeps each submitted pixel buffer until the encode callback. Without a cap,
  /// a slow RTMP ingest lets that queue grow without bound at programme frame rate.
  private var pendingEncodes = 0
  private static let maximumPendingEncodes = 3

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
    return Metrics(megabitsPerSecond: raw.megabitsPerSecond, droppedPackets: raw.droppedPackets)
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
    aac.reset()
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
  }

  public func stop() {
    lock.lock()
    let running = isRunning
    isRunning = false
    let session = self.session
    self.session = nil
    let client = self.client
    self.client = nil
    pendingEncodes = 0
    lock.unlock()
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }
    client?.stop()
    if running { telemetry.recordEncodeSessionChange(delta: -1) }
  }

  public func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
    lock.lock()
    guard isRunning, let session else {
      lock.unlock()
      return
    }
    let now = CFAbsoluteTimeGetCurrent()
    let time = clock.nextPresentationTime(source: presentationTime, now: now)
    let forceKey = clock.shouldForceKey(at: time, now: now) || !sentVideoConfig
    telemetry.recordStreamKeyframeAge(clock.keyframeAgeSeconds(now: now))
    if pendingEncodes >= Self.maximumPendingEncodes {
      clock.requestKeyframe()
      lock.unlock()
      return
    }
    pendingEncodes += 1
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
      lock.unlock()
      return
    }

    let properties: CFDictionary? = forceKey
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
      lock.unlock()
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
        guard let refcon, let sample, status == noErr else { return }
        let streamer = Unmanaged<ProgramStreamer>.fromOpaque(refcon).takeUnretainedValue()
        streamer.didEncode(sample: sample, flags: flags)
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

  private func didEncode(sample: CMSampleBuffer, flags: VTEncodeInfoFlags) {
    lock.lock()
    pendingEncodes = max(0, pendingEncodes - 1)
    lock.unlock()
    if flags.contains(.frameDropped) { return }
    guard let dataBuffer = CMSampleBufferGetDataBuffer(sample) else { return }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
      let pointer, length > 0
    else { return }
    let payload = Data(bytes: pointer, count: length)
    let timestamp = milliseconds(CMSampleBufferGetPresentationTimeStamp(sample))
    let keyframe = Self.payloadContainsIDR(payload) || isKeyframe(sample)
    let now = CFAbsoluteTimeGetCurrent()

    lock.lock()
    if keyframe {
      clock.noteKeyframe(at: CMSampleBufferGetPresentationTimeStamp(sample), now: now)
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
        let format = CMSampleBufferGetFormatDescription(sample),
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
    client.sendVideo(
      timestampMs: timestamp,
      tag: FLVTag.video(keyframe: keyframe, packetType: 1, payload: payload)
    )
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
