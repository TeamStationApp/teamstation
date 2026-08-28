import AudioToolbox
import CoreMedia
import Foundation

/// Builds LPCM `CMSampleBuffer`s from raw samples. Used by the synthetic source's tone
/// generator and by the camera receivers.
public enum AudioSampleBuilder {
  public static let sampleRate: Double = 48_000
  public static let channelCount: UInt32 = 1

  public static func interleavedInt16Description(
    sampleRate: Double = AudioSampleBuilder.sampleRate,
    channels: UInt32 = AudioSampleBuilder.channelCount
  ) -> AudioStreamBasicDescription {
    let bytesPerFrame = 2 * channels
    return AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: bytesPerFrame,
      mFramesPerPacket: 1,
      mBytesPerFrame: bytesPerFrame,
      mChannelsPerFrame: channels,
      mBitsPerChannel: 16,
      mReserved: 0
    )
  }

  public static func makeFormatDescription(
    _ asbd: AudioStreamBasicDescription
  ) -> CMAudioFormatDescription? {
    var description = asbd
    var formatDescription: CMAudioFormatDescription?
    let status = CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      asbd: &description,
      layoutSize: 0,
      layout: nil,
      magicCookieSize: 0,
      magicCookie: nil,
      extensions: nil,
      formatDescriptionOut: &formatDescription
    )
    return status == noErr ? formatDescription : nil
  }

  public static func makeSampleBuffer(
    samples: [Int16],
    formatDescription: CMAudioFormatDescription,
    presentationTime: CMTime
  ) -> CMSampleBuffer? {
    let byteCount = samples.count * MemoryLayout<Int16>.size
    var blockBuffer: CMBlockBuffer?
    var status = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: byteCount,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: byteCount,
      flags: 0,
      blockBufferOut: &blockBuffer
    )
    guard status == kCMBlockBufferNoErr, let blockBuffer else { return nil }

    status = samples.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return OSStatus(kCMBlockBufferBadPointerParameterErr) }
      return CMBlockBufferReplaceDataBytes(
        with: base,
        blockBuffer: blockBuffer,
        offsetIntoDestination: 0,
        dataLength: byteCount
      )
    }
    guard status == kCMBlockBufferNoErr else { return nil }

    // `samples` is interleaved, so its element count is frames × channels, while a sample buffer
    // counts frames. Passing the raw element count made every stereo buffer claim twice the
    // duration it holds, so the audio track advanced at twice real time and ran away from video.
    let channels = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
      .map { Int($0.pointee.mChannelsPerFrame) } ?? 1
    let frameCount = channels > 0 ? samples.count / channels : samples.count

    var sampleBuffer: CMSampleBuffer?
    status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
      allocator: kCFAllocatorDefault,
      dataBuffer: blockBuffer,
      formatDescription: formatDescription,
      sampleCount: frameCount,
      presentationTimeStamp: presentationTime,
      packetDescriptions: nil,
      sampleBufferOut: &sampleBuffer
    )
    guard status == noErr else { return nil }
    return sampleBuffer
  }
}
