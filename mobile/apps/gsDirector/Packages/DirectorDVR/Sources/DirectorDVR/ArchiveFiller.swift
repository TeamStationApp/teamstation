import AudioToolbox
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import VideoToolbox
import DirectorCore
import DirectorSources

/// Encodes black video and silent AAC at a locked size so an archive can hold the recording
/// wall clock when the camera is silent or has changed format.
///
/// Live pictures still go through as a bitstream copy. This session exists for the holes: one
/// small encoder, not a second generation of the live camera.
public final class ArchiveFiller: @unchecked Sendable {
  public let width: Int
  public let height: Int
  public let codec: CompressedFrame.Codec
  public let frameRate: Int
  public let audioSampleRate: Double
  public let audioChannels: Int
  public let magicCookie: Data

  public var frameDuration: CMTime {
    CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1)))
  }

  public var audioDuration: CMTime {
    CMTime(value: CompressedAudioFrame.framesPerPacket, timescale: CMTimeScale(audioSampleRate))
  }

  private let lock = NSLock()
  private var session: VTCompressionSession?
  private var parameterSets: [Data] = []
  private var blackBuffer: CVPixelBuffer?
  private var pending: [EncodedPicture] = []
  private var silentAAC: Data?
  private var audioConverter: AudioConverterRef?

  private struct EncodedPicture {
    var data: Data
    var parameterSets: [Data]
    var isKeyframe: Bool
  }

  public init(
    width: Int,
    height: Int,
    codec: CompressedFrame.Codec = .h264,
    frameRate: Int = 30,
    audioSampleRate: Double = 48_000,
    audioChannels: Int = 2
  ) {
    self.width = width
    self.height = height
    self.codec = codec == .hevc ? .hevc : .h264
    self.frameRate = max(1, frameRate)
    self.audioSampleRate = audioSampleRate
    self.audioChannels = audioChannels
    // AAC-LC AudioSpecificConfig: 48 kHz stereo is 0x11 0x90; other rates still work as a cookie
    // the muxer can describe, and the converter below matches this description.
    self.magicCookie = Data([ 0x11, 0x90 ])
    blackBuffer = Self.makeBlackBuffer(width: width, height: height)
    openEncoder()
    silentAAC = encodeSilencePacket()
    warmupEncoder()
  }

  deinit {
    if let session {
      VTCompressionSessionInvalidate(session)
    }
    if let audioConverter {
      AudioConverterDispose(audioConverter)
    }
  }

  public var lockedParameterSets: [Data] {
    lock.lock()
    defer { lock.unlock() }
    return parameterSets
  }

  /// One black picture at `presentationTime`, already in the archive's length-prefixed form.
  public func encodeBlack(
    sourceID: SourceID,
    presentationTime: CMTime,
    wallClock: WallClock,
    frameID: UInt64
  ) -> CompressedFrame? {
    guard let blackBuffer else { return nil }
    return encode(
      pixelBuffer: blackBuffer,
      sourceID: sourceID,
      presentationTime: presentationTime,
      wallClock: wallClock,
      frameID: frameID,
      forceKeyframe: true
    )
  }

  public func encode(
    pixelBuffer: CVPixelBuffer,
    sourceID: SourceID,
    presentationTime: CMTime,
    wallClock: WallClock,
    frameID: UInt64,
    forceKeyframe: Bool
  ) -> CompressedFrame? {
    lock.lock()
    guard let session else {
      lock.unlock()
      return nil
    }
    lock.unlock()

    let properties: CFDictionary? = forceKeyframe
      ? [ kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue ] as CFDictionary
      : nil
    let status = VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: presentationTime,
      duration: frameDuration,
      frameProperties: properties,
      sourceFrameRefcon: nil,
      infoFlagsOut: nil
    )
    guard status == noErr else { return nil }
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)

    lock.lock()
    let picture = pending.isEmpty ? nil : pending.removeFirst()
    lock.unlock()
    guard let picture else { return nil }
    return CompressedFrame(
      sourceID: sourceID,
      codec: codec,
      data: picture.data,
      parameterSets: picture.parameterSets,
      isKeyframe: picture.isKeyframe,
      presentationTime: presentationTime,
      decodeTime: presentationTime,
      wallClock: wallClock,
      frameID: frameID
    )
  }

  public func encodeSilence(
    sourceID: SourceID,
    presentationTime: CMTime,
    wallClock: WallClock
  ) -> CompressedAudioFrame? {
    guard let silentAAC, !silentAAC.isEmpty else { return nil }
    return CompressedAudioFrame(
      sourceID: sourceID,
      data: silentAAC,
      magicCookie: magicCookie,
      sampleRate: audioSampleRate,
      channelCount: audioChannels,
      presentationTime: presentationTime,
      wallClock: wallClock
    )
  }

  /// Decode a coded picture of any size and re-encode it at the locked size.
  public func transcode(
    _ frame: CompressedFrame,
    presentationTime: CMTime
  ) -> CompressedFrame? {
    guard let pixels = Self.decode(frame) else { return nil }
    let scaled: CVPixelBuffer
    if CVPixelBufferGetWidth(pixels) == width, CVPixelBufferGetHeight(pixels) == height {
      scaled = pixels
    } else {
      guard let transferred = Self.scale(pixels, width: width, height: height) else { return nil }
      scaled = transferred
    }
    return encode(
      pixelBuffer: scaled,
      sourceID: frame.sourceID,
      presentationTime: presentationTime,
      wallClock: frame.wallClock,
      frameID: frame.frameID,
      forceKeyframe: frame.isKeyframe
    )
  }

  private func openEncoder() {
    let codecType: CMVideoCodecType = codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    let attributes: CFDictionary = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey: width,
      kCVPixelBufferHeightKey: height
    ] as CFDictionary
    let callback: VTCompressionOutputCallback = { refcon, _, status, flags, sample in
      guard let refcon, status == noErr, !flags.contains(.frameDropped), let sample else { return }
      let filler = Unmanaged<ArchiveFiller>.fromOpaque(refcon).takeUnretainedValue()
      filler.didEncode(sample)
    }
    // Simulator often has no hardware encoder; prefer hardware, then fall back to software.
    var session: VTCompressionSession?
    var status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: codecType,
      encoderSpecification: [
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue
      ] as CFDictionary,
      imageBufferAttributes: attributes,
      compressedDataAllocator: nil,
      outputCallback: callback,
      refcon: refcon,
      compressionSessionOut: &session
    )
    if status != noErr || session == nil {
      status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(width),
        height: Int32(height),
        codecType: codecType,
        encoderSpecification: nil,
        imageBufferAttributes: attributes,
        compressedDataAllocator: nil,
        outputCallback: callback,
        refcon: refcon,
        compressionSessionOut: &session
      )
    }
    guard status == noErr, let session else { return }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanFalse)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ExpectedFrameRate,
      value: frameRate as CFNumber
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
      value: 1 as CFNumber
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: 1_000_000 as CFNumber
    )
    if codec == .h264 {
      VTSessionSetProperty(
        session,
        key: kVTCompressionPropertyKey_ProfileLevel,
        value: kVTProfileLevel_H264_Baseline_AutoLevel
      )
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
    lock.lock()
    self.session = session
    lock.unlock()
  }

  private func warmupEncoder() {
    guard let blackBuffer else { return }
    _ = encode(
      pixelBuffer: blackBuffer,
      sourceID: SourceID("filler"),
      presentationTime: .zero,
      wallClock: WallClock(seconds: 0),
      frameID: 0,
      forceKeyframe: true
    )
    lock.lock()
    pending.removeAll()
    lock.unlock()
  }

  private func didEncode(_ sample: CMSampleBuffer) {
    guard let dataBuffer = CMSampleBufferGetDataBuffer(sample) else { return }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard
      CMBlockBufferGetDataPointer(
        dataBuffer,
        atOffset: 0,
        lengthAtOffsetOut: nil,
        totalLengthOut: &length,
        dataPointerOut: &pointer
      ) == noErr,
      let pointer, length > 0
    else { return }
    let data = Data(bytes: pointer, count: length)
    let sets: [Data]
    if let format = CMSampleBufferGetFormatDescription(sample) {
      sets = Self.parameterSets(from: format, codec: codec)
    } else {
      sets = []
    }
    let keyframe = CompressedSample.isSyncSample(sample)
    lock.lock()
    if parameterSets.isEmpty, !sets.isEmpty { parameterSets = sets }
    pending.append(
      EncodedPicture(
        data: data,
        parameterSets: parameterSets.isEmpty ? sets : parameterSets,
        isKeyframe: keyframe
      )
    )
    if pending.count > 2 {
      pending.removeFirst(pending.count - 2)
    }
    lock.unlock()
  }

  private func encodeSilencePacket() -> Data? {
    var input = AudioStreamBasicDescription(
      mSampleRate: audioSampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: UInt32(2 * audioChannels),
      mFramesPerPacket: 1,
      mBytesPerFrame: UInt32(2 * audioChannels),
      mChannelsPerFrame: UInt32(audioChannels),
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var output = AudioStreamBasicDescription(
      mSampleRate: audioSampleRate,
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: 1024,
      mBytesPerFrame: 0,
      mChannelsPerFrame: UInt32(audioChannels),
      mBitsPerChannel: 0,
      mReserved: 0
    )
    var converter: AudioConverterRef?
    guard AudioConverterNew(&input, &output, &converter) == noErr, let converter else { return nil }
    audioConverter = converter
    var bitrate: UInt32 = 64_000
    AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate, 4, &bitrate)

    var zeros = [Int16](repeating: 0, count: 1024 * audioChannels)
    var packet = [UInt8](repeating: 0, count: 2048)
    var ioPackets: UInt32 = 1
    var packetDesc = AudioStreamPacketDescription()
    var buffer = AudioBufferList(
      mNumberBuffers: 1,
      mBuffers: AudioBuffer(
        mNumberChannels: UInt32(audioChannels),
        mDataByteSize: UInt32(packet.count),
        mData: &packet
      )
    )
    var inputCount: UInt32 = 1024
    let status = zeros.withUnsafeMutableBufferPointer { pointer in
      var userData = SilenceInput(samples: pointer.baseAddress, remaining: inputCount)
      return AudioConverterFillComplexBuffer(
        converter,
        { _, ioNumberDataPackets, ioData, _, userData in
          guard let userData else { return 1 }
          let input = userData.assumingMemoryBound(to: SilenceInput.self)
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
    let size = packetDesc.mDataByteSize > 0
      ? Int(packetDesc.mDataByteSize)
      : Int(buffer.mBuffers.mDataByteSize)
    return Data(packet.prefix(size))
  }

  private struct SilenceInput {
    var samples: UnsafeMutablePointer<Int16>?
    var remaining: UInt32
  }

  public static func dimensions(of format: CMVideoFormatDescription) -> (width: Int, height: Int) {
    let size = CMVideoFormatDescriptionGetDimensions(format)
    return (Int(size.width), Int(size.height))
  }

  public static func parameterSets(
    from format: CMFormatDescription,
    codec: CompressedFrame.Codec
  ) -> [Data] {
    if codec == .hevc { return hevcParameterSets(from: format) }
    return h264ParameterSets(from: format)
  }

  private static func h264ParameterSets(from format: CMFormatDescription) -> [Data] {
    var count = 0
    var nalLength: Int32 = 0
    guard
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format,
        parameterSetIndex: 0,
        parameterSetPointerOut: nil,
        parameterSetSizeOut: nil,
        parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: &nalLength
      ) == noErr, count > 0
    else { return [] }
    var sets: [Data] = []
    for index in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format,
          parameterSetIndex: index,
          parameterSetPointerOut: &pointer,
          parameterSetSizeOut: &size,
          parameterSetCountOut: nil,
          nalUnitHeaderLengthOut: nil
        ) == noErr, let pointer, size > 0
      else { continue }
      sets.append(Data(bytes: pointer, count: size))
    }
    return sets
  }

  private static func hevcParameterSets(from format: CMFormatDescription) -> [Data] {
    var count = 0
    var nalLength: Int32 = 0
    guard
      CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        format,
        parameterSetIndex: 0,
        parameterSetPointerOut: nil,
        parameterSetSizeOut: nil,
        parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: &nalLength
      ) == noErr, count > 0
    else { return [] }
    var sets: [Data] = []
    for index in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard
        CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
          format,
          parameterSetIndex: index,
          parameterSetPointerOut: &pointer,
          parameterSetSizeOut: &size,
          parameterSetCountOut: nil,
          nalUnitHeaderLengthOut: nil
        ) == noErr, let pointer, size > 0
      else { continue }
      sets.append(Data(bytes: pointer, count: size))
    }
    return sets
  }

  private static func makeBlackBuffer(width: Int, height: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_32BGRA,
      [
        kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any]
      ] as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    if let base = CVPixelBufferGetBaseAddress(buffer) {
      memset(base, 0, CVPixelBufferGetBytesPerRow(buffer) * height)
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  private static func decode(_ frame: CompressedFrame) -> CVPixelBuffer? {
    guard
      let format = CompressedSample.videoFormatDescription(
        codec: frame.codec,
        parameterSets: frame.parameterSets
      )
    else { return nil }
    var session: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: format,
      decoderSpecification: nil,
      imageBufferAttributes: nil,
      outputCallback: nil,
      decompressionSessionOut: &session
    )
    guard status == noErr, let session else { return nil }
    defer { VTDecompressionSessionInvalidate(session) }
    guard
      let sample = CompressedSample.videoSampleBuffer(
        data: frame.data,
        formatDescription: format,
        presentationTime: frame.presentationTime,
        duration: CMTime(value: 1, timescale: 30),
        isKeyframe: frame.isKeyframe
      )
    else { return nil }

    var pixels: CVPixelBuffer?
    var infoFlags = VTDecodeInfoFlags()
    let decodeStatus = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sample,
      flags: [ ._EnableAsynchronousDecompression ],
      infoFlagsOut: &infoFlags,
      outputHandler: { status, _, image, _, _ in
        if status == noErr { pixels = image }
      }
    )
    if decodeStatus == noErr {
      VTDecompressionSessionWaitForAsynchronousFrames(session)
    }
    return pixels
  }

  private static func scale(_ buffer: CVPixelBuffer, width: Int, height: Int) -> CVPixelBuffer? {
    var session: VTPixelTransferSession?
    guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &session) == noErr,
      let session
    else { return nil }
    defer { VTPixelTransferSessionInvalidate(session) }
    VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Trim)
    var destination: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      CVPixelBufferGetPixelFormatType(buffer),
      [
        kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any]
      ] as CFDictionary,
      &destination
    )
    guard status == kCVReturnSuccess, let destination else { return nil }
    guard VTPixelTransferSessionTransferImage(session, from: buffer, to: destination) == noErr else {
      return nil
    }
    return destination
  }
}
