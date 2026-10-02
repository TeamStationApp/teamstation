import CameramanCore
import CameramanEncode
import CoreMedia
import Foundation
import Testing

@Suite("Audio encoder mute")
struct AudioEncoderSilenceTests {
  @Test("Silent PCM still emits one AAC access unit per 1024 samples")
  func muteKeepsAccessUnitCadence() throws {
    let encoder = AudioEncoder()
    let box = FrameBox()
    encoder.onFrame = { box.append($0) }
    encoder.configure(sampleRate: 48_000, channelCount: 1)
    // configure is async on the encoder queue; pendingBytes waits it out.
    _ = encoder.pendingBytes

    let live = try #require(Self.pcmBuffer(samples: 2_048, rate: 48_000, pts: 0, value: 4_000))
    encoder.encode(SampleBufferRef(live), silent: false)
    _ = encoder.pendingBytes
    let liveCount = box.count
    #expect(liveCount >= 1)

    let muted = try #require(Self.pcmBuffer(samples: 8_192, rate: 48_000, pts: 2_048 / 48_000, value: 4_000))
    encoder.encode(SampleBufferRef(muted), silent: true)
    _ = encoder.pendingBytes
    let silentCount = box.count - liveCount
    #expect(silentCount >= 7, "mute must emit AUs, not drop zeros as DTX")
  }

  /// iOS delivers capture buffers stamped on the host clock, and a stretch the system dropped shows
  /// as a jump between them. The encoder re-bases on a buffer's own time when nothing is queued; the
  /// case left is a jump while samples are still waiting, where the sample count runs on regardless
  /// and each frame's capture time must still come from the buffer its first sample belongs to.
  @Test("Each frame's capture time comes from the buffer its first sample belongs to")
  func captureTimeFollowsBuffers() throws {
    let encoder = AudioEncoder()
    let box = FrameBox()
    encoder.onFrame = { box.append($0) }
    encoder.configure(sampleRate: 48_000, channelCount: 1)
    _ = encoder.pendingBytes

    // 1,500 samples: one frame goes out and 476 samples stay queued.
    let first = try #require(Self.pcmBuffer(samples: 1_500, rate: 48_000, pts: 10, value: 4_000))
    encoder.encode(SampleBufferRef(first), silent: false)
    _ = encoder.pendingBytes
    // The next buffer starts where the count says 1,500 samples in, but was captured half a second
    // later than that.
    let boundary = 10 + 1_500.0 / 48_000
    let second = try #require(Self.pcmBuffer(samples: 2_596, rate: 48_000, pts: boundary + 0.5, value: 4_000))
    encoder.encode(SampleBufferRef(second), silent: false)
    _ = encoder.pendingBytes

    let frames = box.all
    try #require(frames.count >= 3, "only \(frames.count) frames came out")
    for frame in frames {
      let position = frame.presentationTime
      let expected = position < boundary - 1e-6 ? position : position + 0.5
      #expect(abs((frame.captureTime ?? 0) - expected) < 0.001, "frame at \(position): \(frame.captureTime ?? -1)")
    }
  }

  private static func pcmBuffer(
    samples: Int,
    rate: Double,
    pts: Double,
    value: Int16
  ) -> CMSampleBuffer? {
    var asbd = AudioStreamBasicDescription(
      mSampleRate: rate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 2,
      mFramesPerPacket: 1,
      mBytesPerFrame: 2,
      mChannelsPerFrame: 1,
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var format: CMAudioFormatDescription?
    guard CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      asbd: &asbd,
      layoutSize: 0,
      layout: nil,
      magicCookieSize: 0,
      magicCookie: nil,
      extensions: nil,
      formatDescriptionOut: &format
    ) == noErr, let format else { return nil }

    var pcm = [Int16](repeating: value, count: samples)
    let byteCount = samples * 2
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: byteCount,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: byteCount,
      flags: 0,
      blockBufferOut: &block
    ) == noErr, let block else { return nil }
    _ = pcm.withUnsafeBytes { raw in
      CMBlockBufferReplaceDataBytes(
        with: raw.baseAddress!,
        blockBuffer: block,
        offsetIntoDestination: 0,
        dataLength: byteCount
      )
    }

    var timing = CMSampleTimingInfo(
      duration: CMTime(value: CMTimeValue(samples), timescale: CMTimeScale(rate)),
      presentationTimeStamp: CMTime(seconds: pts, preferredTimescale: 48_000),
      decodeTimeStamp: .invalid
    )
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: block,
      formatDescription: format,
      sampleCount: samples,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 1,
      sampleSizeArray: [2],
      sampleBufferOut: &sample
    ) == noErr else { return nil }
    return sample
  }
}

private final class FrameBox: @unchecked Sendable {
  private let lock = NSLock()
  private var frames: [EncodedAudioFrame] = []

  func append(_ frame: EncodedAudioFrame) {
    lock.lock()
    frames.append(frame)
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return frames.count
  }

  var all: [EncodedAudioFrame] {
    lock.lock()
    defer { lock.unlock() }
    return frames
  }
}
