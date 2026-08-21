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
  private var baseTime: CMTime?
  private var audioBase: CMTime?
  private var onFailure: FailureHandler?

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
    do {
      try await client.publish(to: url)
    } catch {
      stop()
      throw error
    }
    markStarted(client)
    telemetry.recordEncodeSessionChange(delta: 1)
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
    baseTime = nil
    audioBase = nil
    aac.reset()
    return true
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
    if baseTime == nil { baseTime = presentationTime }
    let base = baseTime ?? presentationTime
    lock.unlock()

    let isEncodable =
      CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      && CVPixelBufferGetWidth(pixelBuffer) == width
      && CVPixelBufferGetHeight(pixelBuffer) == height
    let encodable = isEncodable
      ? pixelBuffer
      : converter.convert(pixelBuffer: pixelBuffer, width: width, height: height)
    guard let encodable else { return }

    var time = CMTimeSubtract(presentationTime, base)
    if time < .zero { time = .zero }
    VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: encodable,
      presentationTimeStamp: time,
      duration: CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1))),
      frameProperties: nil,
      sourceFrameRefcon: nil,
      infoFlagsOut: nil
    )
  }

  public func append(audio frame: AudioFrame) {
    lock.lock()
    guard isRunning, let client else {
      lock.unlock()
      return
    }
    let packets = aac.encode(frame.sampleBuffer)
    let cookie = aac.audioSpecificConfig
    let sentAudio = sentAudioConfig
    if !sentAudioConfig { sentAudioConfig = true }
    let audioTime: CMTime
    if let audioBase {
      audioTime = CMTimeSubtract(frame.sampleBuffer.presentationTimeStamp, audioBase)
    } else {
      audioBase = frame.sampleBuffer.presentationTimeStamp
      audioTime = .zero
    }
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
      value: kVTProfileLevel_H264_High_AutoLevel
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
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTCompressionSessionPrepareToEncodeFrames(session)
    lock.lock()
    self.session = session
    lock.unlock()
  }

  private func didEncode(sample: CMSampleBuffer, flags: VTEncodeInfoFlags) {
    if flags.contains(.frameDropped) { return }
    guard let dataBuffer = CMSampleBufferGetDataBuffer(sample) else { return }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
      let pointer, length > 0
    else { return }
    let payload = Data(bytes: pointer, count: length)
    let timestamp = milliseconds(CMSampleBufferGetPresentationTimeStamp(sample))
    let keyframe = isKeyframe(sample)

    lock.lock()
    guard isRunning, let client else {
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
    if keyframe, !sentVideoConfig, let format = CMSampleBufferGetFormatDescription(sample),
      let record = Self.avcRecord(from: format)
    {
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
    else { return true }
    if let depends = first[kCMSampleAttachmentKey_DependsOnOthers] as? Bool {
      return !depends
    }
    return true
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

    guard let sps = parameterSet(at: 0), let pps = parameterSet(at: 1) else { return nil }
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
    var cookieSize: UInt32 = 0
    if AudioConverterGetPropertyInfo(
      converter,
      kAudioConverterCompressionMagicCookie,
      &cookieSize,
      nil
    ) == noErr, cookieSize > 0 {
      var cookie = [UInt8](repeating: 0, count: Int(cookieSize))
      if AudioConverterGetProperty(
        converter,
        kAudioConverterCompressionMagicCookie,
        &cookieSize,
        &cookie
      ) == noErr {
        audioSpecificConfig = Data(cookie)
      }
    }
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
