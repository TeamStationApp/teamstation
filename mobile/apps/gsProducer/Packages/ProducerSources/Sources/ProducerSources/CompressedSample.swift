import AudioToolbox
import CoreMedia
import Foundation

/// Turns coded bytes into the `CMSampleBuffer`s that VideoToolbox and `AVAssetWriter` both take.
///
/// Shared deliberately: the decoder and the archive are handed the same access unit, and a
/// format description built two slightly different ways is how a stream ends up decodable on screen
/// and unplayable on disk.
public enum CompressedSample {
  /// Access units are length-prefixed with a four-byte size, which is what both the AVCC and HVCC
  /// descriptions below declare.
  public static let nalUnitHeaderLength: Int32 = 4

  // MARK: - Video

  public static func videoFormatDescription(
    codec: CompressedFrame.Codec,
    parameterSets sets: [Data]
  ) -> CMVideoFormatDescription? {
    // No camera in the population sends AV1, and guessing at a configuration record would produce
    // a file that looks written and does not play.
    guard codec != .av1 else { return nil }
    let required = codec == .hevc ? 3 : 2
    guard sets.count >= required, sets.allSatisfy({ !$0.isEmpty }) else { return nil }

    // VideoToolbox wants an array of pointers, which cannot be built from nested
    // `withUnsafeBufferPointer` calls without letting the pointers escape their own scope. Owning
    // the memory outright for the duration of the call is the only version that is actually valid.
    var pointers: [UnsafePointer<UInt8>] = []
    var sizes: [Int] = []
    var allocations: [UnsafeMutablePointer<UInt8>] = []
    defer { allocations.forEach { $0.deallocate() } }

    for set in sets {
      let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: set.count)
      set.copyBytes(to: buffer, count: set.count)
      allocations.append(buffer)
      pointers.append(UnsafePointer(buffer))
      sizes.append(set.count)
    }

    var description: CMVideoFormatDescription?
    let status: OSStatus = switch codec {
    case .h264:
      CMVideoFormatDescriptionCreateFromH264ParameterSets(
        allocator: kCFAllocatorDefault,
        parameterSetCount: pointers.count,
        parameterSetPointers: &pointers,
        parameterSetSizes: &sizes,
        nalUnitHeaderLength: nalUnitHeaderLength,
        formatDescriptionOut: &description
      )
    case .hevc:
      CMVideoFormatDescriptionCreateFromHEVCParameterSets(
        allocator: kCFAllocatorDefault,
        parameterSetCount: pointers.count,
        parameterSetPointers: &pointers,
        parameterSetSizes: &sizes,
        nalUnitHeaderLength: nalUnitHeaderLength,
        extensions: nil,
        formatDescriptionOut: &description
      )
    case .av1:
      noErr
    }
    return status == noErr ? description : nil
  }

  /// Wraps one access unit for decode or for the muxer.
  ///
  /// `duration` matters more than it looks: in fragmented MP4 the per-sample durations *are* the
  /// timeline, so a writer refuses a sample that does not carry one. The decoder does not care.
  public static func videoSampleBuffer(
    data: Data,
    formatDescription: CMVideoFormatDescription,
    presentationTime: CMTime,
    duration: CMTime = .invalid,
    isKeyframe: Bool = true
  ) -> CMSampleBuffer? {
    guard !data.isEmpty else { return nil }

    var blockBuffer: CMBlockBuffer?
    var status = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: data.count,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: data.count,
      flags: 0,
      blockBufferOut: &blockBuffer
    )
    guard status == kCMBlockBufferNoErr, let blockBuffer else { return nil }

    status = data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else {
        return OSStatus(kCMBlockBufferBadPointerParameterErr)
      }
      return CMBlockBufferReplaceDataBytes(
        with: base,
        blockBuffer: blockBuffer,
        offsetIntoDestination: 0,
        dataLength: data.count
      )
    }
    guard status == kCMBlockBufferNoErr else { return nil }

    var sampleSize = data.count
    var timing = CMSampleTimingInfo(
      duration: duration,
      presentationTimeStamp: presentationTime,
      decodeTimeStamp: .invalid
    )
    var sampleBuffer: CMSampleBuffer?
    status = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: blockBuffer,
      formatDescription: formatDescription,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &sampleSize,
      sampleBufferOut: &sampleBuffer
    )
    guard status == noErr, let sampleBuffer else { return nil }

    if !isKeyframe { markNotSync(sampleBuffer) }
    return sampleBuffer
  }

  /// Marks a sample as one that cannot be seeked to.
  ///
  /// Without this every frame claims to be a sync sample, and a player told that any frame is an
  /// entry point produces a smear of macroblocks whenever the operator seeks.
  private static func markNotSync(_ sampleBuffer: CMSampleBuffer) {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(
        sampleBuffer,
        createIfNecessary: true
      ),
      CFArrayGetCount(attachments) > 0
    else { return }

    let raw = CFArrayGetValueAtIndex(attachments, 0)
    let dictionary = unsafeBitCast(raw, to: CFMutableDictionary.self)
    CFDictionarySetValue(
      dictionary,
      Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(),
      Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
    )
    CFDictionarySetValue(
      dictionary,
      Unmanaged.passUnretained(kCMSampleAttachmentKey_DependsOnOthers).toOpaque(),
      Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
    )
  }

  public static func isSyncSample(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(
        sampleBuffer,
        createIfNecessary: false
      ) as? [[CFString: Any]],
      let first = attachments.first,
      let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool
    else { return true }
    return !notSync
  }

  // MARK: - Audio

  /// Describes an AAC track from the AudioSpecificConfig the SDP carried.
  ///
  /// `AVAssetWriter` copies this cookie into the `esds` box as-is (after version/flags). Passing
  /// the two-byte AudioSpecificConfig produces a truncated descriptor; ffmpeg reports
  /// "overread end of atom 'esds'" and `AVPlayer` fails to open the HLS init with
  /// CoreMediaErrorDomain -12848.
  public static func aacFormatDescription(
    magicCookie: Data,
    sampleRate: Double,
    channelCount: Int
  ) -> CMAudioFormatDescription? {
    guard !magicCookie.isEmpty, sampleRate > 0, channelCount > 0 else { return nil }
    let cookie = mpeg4ESDescriptor(audioSpecificConfig: magicCookie)

    var asbd = AudioStreamBasicDescription(
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

    var description: CMAudioFormatDescription?
    let status = cookie.withUnsafeBytes { bytes in
      CMAudioFormatDescriptionCreate(
        allocator: kCFAllocatorDefault,
        asbd: &asbd,
        layoutSize: 0,
        layout: nil,
        magicCookieSize: bytes.count,
        magicCookie: bytes.baseAddress,
        extensions: nil,
        formatDescriptionOut: &description
      )
    }
    return status == noErr ? description : nil
  }

  /// ISO-14496-1 ES_Descriptor wrapping an AAC AudioSpecificConfig, which is what an `esds`
  /// box must contain. An already-wrapped cookie (tag `0x03`) is returned unchanged.
  public static func mpeg4ESDescriptor(audioSpecificConfig config: Data) -> Data {
    guard !config.isEmpty else { return config }
    if config.first == 0x03 { return config }

    let decoderSpecific = mpeg4Descriptor(tag: 0x05, payload: config)
    var decoderConfig = Data([
      0x40, 0x15,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00
    ])
    decoderConfig.append(decoderSpecific)
    let decoderConfigDescriptor = mpeg4Descriptor(tag: 0x04, payload: decoderConfig)
    let slConfig = mpeg4Descriptor(tag: 0x06, payload: Data([0x02]))
    var elementary = Data([0x00, 0x00, 0x00])
    elementary.append(decoderConfigDescriptor)
    elementary.append(slConfig)
    return mpeg4Descriptor(tag: 0x03, payload: elementary)
  }

  private static func mpeg4Descriptor(tag: UInt8, payload: Data) -> Data {
    var descriptor = Data([tag, UInt8(min(payload.count, 127))])
    descriptor.append(payload.prefix(127))
    return descriptor
  }

  public static func audioSampleBuffer(
    data: Data,
    formatDescription: CMAudioFormatDescription,
    presentationTime: CMTime,
    duration: CMTime
  ) -> CMSampleBuffer? {
    guard !data.isEmpty else { return nil }

    var blockBuffer: CMBlockBuffer?
    var status = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: data.count,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: data.count,
      flags: 0,
      blockBufferOut: &blockBuffer
    )
    guard status == kCMBlockBufferNoErr, let blockBuffer else { return nil }

    status = data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else {
        return OSStatus(kCMBlockBufferBadPointerParameterErr)
      }
      return CMBlockBufferReplaceDataBytes(
        with: base,
        blockBuffer: blockBuffer,
        offsetIntoDestination: 0,
        dataLength: data.count
      )
    }
    guard status == kCMBlockBufferNoErr else { return nil }

    // A compressed audio sample is one packet of a known byte count, which the muxer needs spelled
    // out: unlike LPCM it cannot infer packet size from the format.
    var packet = AudioStreamPacketDescription(
      mStartOffset: 0,
      mVariableFramesInPacket: 0,
      mDataByteSize: UInt32(data.count)
    )
    var sampleBuffer: CMSampleBuffer?
    status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
      allocator: kCFAllocatorDefault,
      dataBuffer: blockBuffer,
      formatDescription: formatDescription,
      sampleCount: 1,
      presentationTimeStamp: presentationTime,
      packetDescriptions: &packet,
      sampleBufferOut: &sampleBuffer
    )
    guard status == noErr, let sampleBuffer else { return nil }

    guard duration.isNumeric, duration > .zero else { return sampleBuffer }
    var timing = CMSampleTimingInfo(
      duration: duration,
      presentationTimeStamp: presentationTime,
      decodeTimeStamp: .invalid
    )
    var retimed: CMSampleBuffer?
    guard CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sampleBuffer,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &retimed
    ) == noErr, let retimed else { return sampleBuffer }
    return retimed
  }
}
