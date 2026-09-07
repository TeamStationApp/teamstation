import AudioToolbox
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Encodes decoded pixels into what a camera would have put on the wire: coded access units, their
/// parameter sets, and AAC.
///
/// The archive is a passthrough muxer — a camera's own bytes reach the file unaltered — so any
/// source that hands the pipeline pixels rather than a bitstream has nothing to write with. Two do:
/// the simulated cameras, and NDI cameras, whose bitstream the free NDI SDK decodes before a
/// receiver ever sees it.
///
/// The encode is deliberately camera-like: no frame reordering, and a keyframe about once a second,
/// which is both what the VM33s send and what keeps a 3-second segment 3 seconds long — the writer
/// cuts on sync samples, so a longer GOP silently produces longer chunks.
public final class WireVideoEncoder: @unchecked Sendable {
  /// One coded picture, ready to be published as a `CompressedFrame`.
  public struct Unit: @unchecked Sendable {
    public let data: Data
    public let parameterSets: [Data]
    public let isKeyframe: Bool
    public let presentationTime: CMTime
  }

  public let codec: CompressedFrame.Codec
  /// Whether this encoder accepted a hard data-rate ceiling. Not every encoder supports one, and
  /// the difference is worth knowing rather than guessing: without it `AverageBitRate` is only a
  /// hint and the output can be several times the requested rate.
  public private(set) var dataRateLimitStatus: OSStatus = noErr
  /// The frame rate the session currently believes it is encoding.
  private var expectedFrameRate: Double = 0
  /// Presentation time of the last frame this encoder was told to make a keyframe.
  private var lastForcedKeyframe: CMTime = .invalid
  /// How often a keyframe is demanded, in seconds of presentation time.
  private let keyframeInterval: Double = 1

  /// Optional only because `VTCompressionSessionCreate` needs a pointer to `self` as its callback
  /// context, which is not available until every stored property has a value.
  private var session: VTCompressionSession?
  private let lock = NSLock()
  private var handler: ((Unit) -> Void)?

  public init?(
    width: Int,
    height: Int,
    frameRate: Double,
    codec: CompressedFrame.Codec,
    bitrate: Int = 6_000_000
  ) {
    guard codec != .av1 else { return nil }
    self.codec = codec

    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: { context, _, status, _, sampleBuffer in
        guard let context, status == noErr, let sampleBuffer else { return }
        Unmanaged<WireVideoEncoder>.fromOpaque(context)
          .takeUnretainedValue()
          .publish(sampleBuffer)
      },
      refcon: Unmanaged.passUnretained(self).toOpaque(),
      compressionSessionOut: &created
    )
    guard status == noErr, let session = created else { return nil }
    self.session = session
    self.configure(session, frameRate: frameRate, bitrate: bitrate)
  }

  private func configure(_ session: VTCompressionSession, frameRate: Double, bitrate: Int) {
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AllowFrameReordering,
      value: kCFBooleanFalse
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_AverageBitRate,
      value: NSNumber(value: bitrate)
    )
    // A hard ceiling as well as an average, because `AverageBitRate` on its own is a hint that
    // VideoToolbox overshoots badly on hard content. Measured on 1080p noise: an 8 Mbps request
    // produced 22.7 Mbps in HEVC and 26.0 in H.264 at 60 fps, and asking for 4 against 16 changed
    // the output by less than half an octave. A recording three times its budget fills the disk
    // three times as fast and pushes an export past what the operator was told to expect.
    //
    // The window is one second and the allowance 1.25x, which leaves room for the keyframe this
    // encoder emits every second — a tighter cap makes the frame after each keyframe collapse.
    let ceilingBytes = Double(bitrate) / 8 * 1.25
    dataRateLimitStatus = VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_DataRateLimits,
      value: [ NSNumber(value: ceilingBytes), NSNumber(value: 1.0) ] as CFArray
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
      value: NSNumber(value: 1.0)
    )
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ExpectedFrameRate,
      value: NSNumber(value: frameRate)
    )
    expectedFrameRate = frameRate
    VTCompressionSessionPrepareToEncodeFrames(session)
  }

  deinit {
    if let session { VTCompressionSessionInvalidate(session) }
  }

  /// Tells the session the rate it is *actually* being fed, which is not always the rate the
  /// source runs at.
  ///
  /// This matters for segment length, not for quality. `MaxKeyFrameIntervalDuration` is one second,
  /// but VideoToolbox reckons that against `ExpectedFrameRate` — so an encoder told 30 fps and then
  /// fed 7.5 emits a keyframe every four seconds of real time. `SegmentWriter` cuts on sync
  /// samples, so segments stretched to 7.9 s when a 1080p HEVC archive decimated, against the three
  /// seconds every other source produces. Measured on a simulator, where the software encoder makes
  /// decimation certain; on a thermally throttled iPad it would be the same shape.
  public func setExpectedFrameRate(_ frameRate: Double) {
    lock.lock()
    let session = self.session
    let unchanged = abs(frameRate - expectedFrameRate) < 0.01
    if !unchanged { expectedFrameRate = frameRate }
    lock.unlock()
    guard !unchanged, let session, frameRate > 0 else { return }
    VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_ExpectedFrameRate,
      value: NSNumber(value: frameRate)
    )
  }

  public func setHandler(_ handler: ((Unit) -> Void)?) {
    lock.lock()
    self.handler = handler
    lock.unlock()
  }

  public func encode(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime, duration: CMTime) {
    guard let session else { return }

    // The keyframe cadence is demanded here rather than left to the encoder's own interval.
    //
    // `MaxKeyFrameIntervalDuration` is set to one second, but VideoToolbox reckons it against the
    // frame rate it was told, and a source that decimates its archive under encoder pressure feeds
    // a fraction of that. Measured: a stride-4 1080p HEVC archive emitted a keyframe every four
    // seconds, and since `SegmentWriter` cuts on sync samples its segments came out at 7.8 s
    // against the three seconds every other source produces — which is the whole basis of scrub,
    // replay and export behaving the same way for every camera. Updating `ExpectedFrameRate` on the
    // live session did not move it; asking for the keyframe outright does, and does not depend on
    // the encoder agreeing with us about the rate.
    lock.lock()
    let due = !lastForcedKeyframe.isNumeric
      || CMTimeGetSeconds(CMTimeSubtract(presentationTime, lastForcedKeyframe)) >= keyframeInterval
    if due { lastForcedKeyframe = presentationTime }
    lock.unlock()

    let properties: CFDictionary? = due
      ? [ kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue ] as CFDictionary
      : nil

    VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: presentationTime,
      duration: duration,
      frameProperties: properties,
      sourceFrameRefcon: nil,
      infoFlagsOut: nil
    )
  }

  public func finish() {
    if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid) }
    setHandler(nil)
  }

  private func publish(_ sampleBuffer: CMSampleBuffer) {
    guard
      let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer),
      let description = CMSampleBufferGetFormatDescription(sampleBuffer)
    else { return }

    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(
      blockBuffer,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &length,
      dataPointerOut: &pointer
    ) == kCMBlockBufferNoErr, let pointer, length > 0 else { return }

    lock.lock()
    let handler = self.handler
    lock.unlock()
    guard let handler else { return }

    // VideoToolbox already emits four-byte length-prefixed units, which is exactly what
    // `CompressedSample` declares, so the bytes go on unaltered.
    handler(Unit(
      data: Data(bytes: pointer, count: length),
      parameterSets: Self.parameterSets(from: description, codec: codec),
      isKeyframe: CompressedSample.isSyncSample(sampleBuffer),
      presentationTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    ))
  }

  /// Reads SPS/PPS (and VPS for HEVC) back out of the encoder's own format description, so the
  /// simulated camera advertises its parameter sets the way an SDP does.
  private static func parameterSets(
    from description: CMFormatDescription,
    codec: CompressedFrame.Codec
  ) -> [Data] {
    var count = 0
    let counted: OSStatus = codec == .hevc
      ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        description,
        parameterSetIndex: 0,
        parameterSetPointerOut: nil,
        parameterSetSizeOut: nil,
        parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: nil
      )
      : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        description,
        parameterSetIndex: 0,
        parameterSetPointerOut: nil,
        parameterSetSizeOut: nil,
        parameterSetCountOut: &count,
        nalUnitHeaderLengthOut: nil
      )
    guard counted == noErr, count > 0 else { return [] }

    var sets: [Data] = []
    for index in 0 ..< count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      let status: OSStatus = codec == .hevc
        ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
          description,
          parameterSetIndex: index,
          parameterSetPointerOut: &pointer,
          parameterSetSizeOut: &size,
          parameterSetCountOut: nil,
          nalUnitHeaderLengthOut: nil
        )
        : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          description,
          parameterSetIndex: index,
          parameterSetPointerOut: &pointer,
          parameterSetSizeOut: &size,
          parameterSetCountOut: nil,
          nalUnitHeaderLengthOut: nil
        )
      guard status == noErr, let pointer, size > 0 else { return [] }
      sets.append(Data(bytes: pointer, count: size))
    }
    return sets
  }
}

/// Encodes PCM to AAC-LC, for the same reason the video is encoded: the archive has to be the same
/// shape whatever the source was, and a passthrough writer has nothing to write from PCM.
public final class WireAudioEncoder: @unchecked Sendable {
  public struct Packet: Sendable {
    public let data: Data
    /// Sample index of the packet's first frame, on the source's own audio clock.
    public let startFrame: Int64
  }

  public let sampleRate: Double
  public let channelCount: Int
  /// The AudioSpecificConfig, which a muxer needs to describe the track. Empty until the converter
  /// has produced it, which it does before the first packet.
  public private(set) var magicCookie = Data()

  private let converter: AudioConverterRef
  private let lock = NSLock()
  private var pending: [Int16] = []
  private var framesEncoded: Int64 = 0

  /// The one chunk being handed to the converter. Owned memory, because the converter reads it
  /// after the input callback returns.
  private var inputBuffer: UnsafeMutableRawPointer?
  private var inputByteCount = 0
  private var inputConsumed = false

  public init?(sampleRate: Double = AudioSampleBuilder.sampleRate, channelCount: Int = 1) {
    var input = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: UInt32(2 * channelCount),
      mFramesPerPacket: 1,
      mBytesPerFrame: UInt32(2 * channelCount),
      mChannelsPerFrame: UInt32(channelCount),
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var output = AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: UInt32(CompressedAudioFrame.framesPerPacket),
      mBytesPerFrame: 0,
      mChannelsPerFrame: UInt32(channelCount),
      mBitsPerChannel: 0,
      mReserved: 0
    )

    var created: AudioConverterRef?
    guard AudioConverterNew(&input, &output, &created) == noErr, let converter = created else {
      return nil
    }
    self.converter = converter
    self.sampleRate = sampleRate
    self.channelCount = channelCount
  }

  deinit {
    AudioConverterDispose(converter)
    inputBuffer?.deallocate()
  }

  /// Accepts any number of PCM frames and returns whatever whole AAC packets they completed. AAC
  /// codes a fixed 1024 frames at a time and the generator emits one video frame's worth, so the
  /// remainder has to be carried rather than padded — padding would insert silence into the middle
  /// of the tone and A/V sync would drift by a frame per second.
  public func encode(_ samples: [Int16]) -> [Packet] {
    lock.lock()
    defer { lock.unlock() }

    pending.append(contentsOf: samples)
    let chunk = Int(CompressedAudioFrame.framesPerPacket) * channelCount
    var packets: [Packet] = []

    while pending.count >= chunk {
      let slice = Array(pending.prefix(chunk))
      pending.removeFirst(chunk)
      guard let data = encodeOnePacket(slice) else { continue }
      packets.append(Packet(data: data, startFrame: framesEncoded))
      framesEncoded += CompressedAudioFrame.framesPerPacket
    }
    return packets
  }

  private func encodeOnePacket(_ samples: [Int16]) -> Data? {
    let byteCount = samples.count * 2
    let buffer = UnsafeMutableRawPointer.allocate(
      byteCount: byteCount,
      alignment: MemoryLayout<Int16>.alignment
    )
    samples.withUnsafeBytes { raw in
      if let base = raw.baseAddress { buffer.copyMemory(from: base, byteCount: byteCount) }
    }
    inputBuffer?.deallocate()
    inputBuffer = buffer
    inputByteCount = byteCount
    inputConsumed = false

    // AAC-LC at any sane bitrate is far below this; the converter reports what it used.
    var output = [UInt8](repeating: 0, count: 4_096)
    var packetDescription = AudioStreamPacketDescription()
    var packetCount: UInt32 = 1

    let status = output.withUnsafeMutableBytes { raw -> OSStatus in
      var bufferList = AudioBufferList(
        mNumberBuffers: 1,
        mBuffers: AudioBuffer(
          mNumberChannels: UInt32(channelCount),
          mDataByteSize: UInt32(raw.count),
          mData: raw.baseAddress
        )
      )
      return AudioConverterFillComplexBuffer(
        converter,
        { _, packetCount, bufferList, packetDescriptions, context in
          guard let context else { return kAudio_ParamError }
          return Unmanaged<WireAudioEncoder>.fromOpaque(context)
            .takeUnretainedValue()
            .provideInput(
              packetCount: packetCount,
              bufferList: bufferList,
              packetDescriptions: packetDescriptions
            )
        },
        Unmanaged.passUnretained(self).toOpaque(),
        &packetCount,
        &bufferList,
        &packetDescription
      )
    }

    guard status == noErr || status == Self.noEndOfStream, packetCount == 1 else { return nil }
    if magicCookie.isEmpty { readMagicCookie() }

    let start = Int(packetDescription.mStartOffset)
    let size = Int(packetDescription.mDataByteSize)
    guard size > 0, start + size <= output.count else { return nil }
    return Data(output[start ..< start + size])
  }

  private static let noEndOfStream: OSStatus = 1

  private func provideInput(
    packetCount: UnsafeMutablePointer<UInt32>,
    bufferList: UnsafeMutablePointer<AudioBufferList>,
    packetDescriptions: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?
  ) -> OSStatus {
    guard let inputBuffer, !inputConsumed else {
      packetCount.pointee = 0
      return Self.noEndOfStream
    }
    inputConsumed = true

    bufferList.pointee.mNumberBuffers = 1
    bufferList.pointee.mBuffers.mNumberChannels = UInt32(channelCount)
    bufferList.pointee.mBuffers.mDataByteSize = UInt32(inputByteCount)
    bufferList.pointee.mBuffers.mData = inputBuffer
    packetCount.pointee = UInt32(inputByteCount / (2 * channelCount))
    if packetDescriptions != nil { packetDescriptions?.pointee = nil }
    return noErr
  }

  private func readMagicCookie() {
    var size: UInt32 = 0
    guard AudioConverterGetPropertyInfo(
      converter,
      kAudioConverterCompressionMagicCookie,
      &size,
      nil
    ) == noErr, size > 0 else { return }

    var cookie = [UInt8](repeating: 0, count: Int(size))
    guard AudioConverterGetProperty(
      converter,
      kAudioConverterCompressionMagicCookie,
      &size,
      &cookie
    ) == noErr else { return }
    magicCookie = Data(cookie.prefix(Int(size)))
  }
}
