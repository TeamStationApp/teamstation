import AudioToolbox
import CoreMedia
import Foundation

/// Decodes the cameras' AAC-LC audio to the interleaved 16-bit PCM the mixer and the archive writer
/// both consume.
///
/// It resamples on the way out as well. The cameras send 32 kHz and the programme bus runs at
/// 48 kHz, and without a real converter here that gap falls to the mixer's nearest-neighbour
/// fallback — audible on speech, and applied to every camera rather than to some rare oddity.
public final class AACAudioDecoder: @unchecked Sendable {
  public struct Statistics: Sendable, Equatable {
    public var decodedFrames: UInt64 = 0
    public var failures: UInt64 = 0

    public init() {}
  }

  public struct Output: Sendable {
    public let samples: [Int16]
    public let sampleRate: Double
    public let channelCount: Int
  }

  public let sourceSampleRate: Double
  public let channelCount: Int
  /// The rate actually produced. Equal to the requested rate unless the converter refused it.
  public let outputSampleRate: Double

  private let converter: AudioConverterRef
  private let lock = NSLock()
  private var statistics = Statistics()

  /// The one packet being decoded. Owned memory rather than a `Data` closure pointer, because the
  /// converter reads it after the callback has returned.
  private var inputBuffer: UnsafeMutableRawPointer?
  private var inputByteCount = 0
  private var inputConsumed = false
  private var packetDescription = AudioStreamPacketDescription()

  /// AAC-LC always codes 1024 samples per channel per frame.
  private static let framesPerPacket: UInt32 = 1_024

  public init?(config: AudioSpecificConfig, magicCookie: Data, outputSampleRate requested: Double) {
    let channels = min(2, config.channelCount)
    let source = Double(config.sampleRate)

    guard let (converter, resolvedRate) = Self.makeConverter(
      sourceSampleRate: source,
      channels: channels,
      requestedOutputRate: requested
    ) else { return nil }

    self.converter = converter
    channelCount = channels
    sourceSampleRate = source
    outputSampleRate = resolvedRate

    // The AudioSpecificConfig is the decoder's magic cookie. Supplying it is what makes the
    // converter certain of the profile rather than inferring it from the stream.
    if !magicCookie.isEmpty {
      var cookie = [UInt8](magicCookie)
      AudioConverterSetProperty(
        converter,
        kAudioConverterDecompressionMagicCookie,
        UInt32(cookie.count),
        &cookie
      )
    }
  }

  deinit {
    AudioConverterDispose(converter)
    inputBuffer?.deallocate()
  }

  public var currentStatistics: Statistics {
    lock.lock()
    defer { lock.unlock() }
    return statistics
  }

  /// Decodes one access unit. Returns `nil` when the converter rejected it, which is counted.
  public func decode(_ accessUnit: Data) -> Output? {
    guard !accessUnit.isEmpty else { return nil }

    lock.lock()
    defer {
      inputBuffer?.deallocate()
      inputBuffer = nil
      inputByteCount = 0
      lock.unlock()
    }

    let buffer = UnsafeMutableRawPointer.allocate(
      byteCount: accessUnit.count,
      alignment: MemoryLayout<UInt8>.alignment
    )
    accessUnit.withUnsafeBytes { raw in
      if let base = raw.baseAddress { buffer.copyMemory(from: base, byteCount: raw.count) }
    }
    inputBuffer = buffer
    inputByteCount = accessUnit.count
    inputConsumed = false
    packetDescription = AudioStreamPacketDescription(
      mStartOffset: 0,
      mVariableFramesInPacket: 0,
      mDataByteSize: UInt32(accessUnit.count)
    )

    // Rate conversion means the output frame count is not the input's, so the buffer is sized for
    // the worst case rather than the expected one.
    let ratio = outputSampleRate / sourceSampleRate
    let capacityFrames = Int((Double(Self.framesPerPacket) * ratio).rounded(.up)) + 64
    var samples = [Int16](repeating: 0, count: capacityFrames * channelCount)
    var producedFrames = UInt32(capacityFrames)

    let status = samples.withUnsafeMutableBytes { raw -> OSStatus in
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
          return Unmanaged<AACAudioDecoder>.fromOpaque(context)
            .takeUnretainedValue()
            .provideInput(
              packetCount: packetCount,
              bufferList: bufferList,
              packetDescriptions: packetDescriptions
            )
        },
        Unmanaged.passUnretained(self).toOpaque(),
        &producedFrames,
        &bufferList,
        nil
      )
    }

    // `noEndOfStream` is how the input callback says "that was the only packet", so it is a normal
    // outcome rather than a failure.
    guard status == noErr || status == Self.noEndOfStream, producedFrames > 0 else {
      statistics.failures &+= 1
      return nil
    }

    statistics.decodedFrames &+= 1
    return Output(
      samples: Array(samples.prefix(Int(producedFrames) * channelCount)),
      sampleRate: outputSampleRate,
      channelCount: channelCount
    )
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
    packetCount.pointee = 1
    if let packetDescriptions {
      withUnsafeMutablePointer(to: &packetDescription) { packetDescriptions.pointee = $0 }
    }
    return noErr
  }

  /// Tries the programme rate first and falls back to the camera's own.
  ///
  /// Not every decode-plus-resample pairing is available in a single converter, and audio at the
  /// wrong rate is still usable where no audio at all is not.
  private static func makeConverter(
    sourceSampleRate: Double,
    channels: Int,
    requestedOutputRate: Double
  ) -> (AudioConverterRef, Double)? {
    var input = AudioStreamBasicDescription(
      mSampleRate: sourceSampleRate,
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: framesPerPacket,
      mBytesPerFrame: 0,
      mChannelsPerFrame: UInt32(channels),
      mBitsPerChannel: 0,
      mReserved: 0
    )

    for rate in [ requestedOutputRate, sourceSampleRate ] {
      var output = pcmDescription(sampleRate: rate, channels: channels)
      var converter: AudioConverterRef?
      if AudioConverterNew(&input, &output, &converter) == noErr, let converter {
        return (converter, rate)
      }
    }
    return nil
  }

  private static func pcmDescription(sampleRate: Double, channels: Int) -> AudioStreamBasicDescription {
    let bytesPerFrame = UInt32(2 * channels)
    return AudioStreamBasicDescription(
      mSampleRate: sampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: bytesPerFrame,
      mFramesPerPacket: 1,
      mBytesPerFrame: bytesPerFrame,
      mChannelsPerFrame: UInt32(channels),
      mBitsPerChannel: 16,
      mReserved: 0
    )
  }
}
