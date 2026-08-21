import AudioToolbox
import CameramanCore
import CoreMedia
import Foundation

/// AAC-LC encoding of the captured microphone stream.
///
/// Emits raw access units with no ADTS header, because RTP `mpeg4-generic` carries bare AUs and a
/// client that receives ADTS-wrapped frames decodes seven bytes of header as audio.
public final class AudioEncoder: @unchecked Sendable {
  public enum Failure: Error, CustomStringConvertible {
    case converter(OSStatus)
    case unsupported(sampleRate: Int, channels: Int)

    public var description: String {
      switch self {
      case .converter(let status): "could not create an AAC converter (\(status))"
      case .unsupported(let rate, let channels): "AAC cannot express \(rate) Hz / \(channels)ch"
      }
    }
  }

  private let queue = DispatchQueue(label: "co.gamestation.cameraman.audio")
  private var converter: AudioConverterRef?
  private var sourceFormat = AudioStreamBasicDescription()
  private var destinationFormat = AudioStreamBasicDescription()
  private var pending = Data()
  private var pendingTime: Double = 0
  private var bytesPerSourceFrame = 0

  /// The `AudioSpecificConfig` for the SDP's `config=`. Known before the first packet, because it
  /// depends only on the negotiated format.
  public private(set) var audioSpecificConfig: Data?

  public var onFrame: (@Sendable (EncodedAudioFrame) -> Void)?
  public var onFailure: (@Sendable (Failure) -> Void)?

  /// AAC-LC always codes 1024 samples per access unit, which is also what the RTP timestamp step is.
  public static let samplesPerFrame = 1024

  public init() {}

  public func configure(sampleRate: Int, channelCount: Int) {
    queue.async { [self] in
      guard let config = AudioSpecificConfigBuilder.aacLC(
        sampleRate: sampleRate,
        channelCount: channelCount
      ) else {
        onFailure?(.unsupported(sampleRate: sampleRate, channels: channelCount))
        return
      }

      teardownLocked()

      sourceFormat = AudioStreamBasicDescription(
        mSampleRate: Double(sampleRate),
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: UInt32(2 * channelCount),
        mFramesPerPacket: 1,
        mBytesPerFrame: UInt32(2 * channelCount),
        mChannelsPerFrame: UInt32(channelCount),
        mBitsPerChannel: 16,
        mReserved: 0
      )
      destinationFormat = AudioStreamBasicDescription(
        mSampleRate: Double(sampleRate),
        mFormatID: kAudioFormatMPEG4AAC,
        mFormatFlags: 0,
        mBytesPerPacket: 0,
        mFramesPerPacket: UInt32(Self.samplesPerFrame),
        mBytesPerFrame: 0,
        mChannelsPerFrame: UInt32(channelCount),
        mBitsPerChannel: 0,
        mReserved: 0
      )
      bytesPerSourceFrame = 2 * channelCount

      var created: AudioConverterRef?
      let status = AudioConverterNew(&sourceFormat, &destinationFormat, &created)
      guard status == noErr, let created else {
        onFailure?(.converter(status))
        return
      }
      converter = created
      audioSpecificConfig = config
    }
  }

  public func encode(_ sample: SampleBufferRef) {
    queue.async { [self] in
      guard converter != nil else { return }
      guard let block = CMSampleBufferGetDataBuffer(sample.buffer) else { return }

      var length = 0
      var pointer: UnsafeMutablePointer<Int8>?
      guard CMBlockBufferGetDataPointer(
        block,
        atOffset: 0,
        lengthAtOffsetOut: nil,
        totalLengthOut: &length,
        dataPointerOut: &pointer
      ) == noErr, let pointer else { return }

      if pending.isEmpty {
        pendingTime = CMSampleBufferGetPresentationTimeStamp(sample.buffer).seconds
      }
      pending.append(Data(bytes: pointer, count: length))
      drain()
    }
  }

  public func invalidate() {
    queue.async { [self] in teardownLocked() }
  }

  /// The converter needs whole 1024-sample frames, and a capture callback delivers whatever the
  /// hardware felt like. Anything short of a frame is held over rather than padded with silence,
  /// which would put a click into the stream every buffer boundary.
  private func drain() {
    guard let converter, bytesPerSourceFrame > 0 else { return }
    let bytesPerFrame = Self.samplesPerFrame * bytesPerSourceFrame

    while pending.count >= bytesPerFrame {
      let chunk = pending.prefix(bytesPerFrame)
      pending.removeFirst(bytesPerFrame)

      var output = Data(count: 2048)
      var packetCount: UInt32 = 1
      var packetDescription = AudioStreamPacketDescription()

      let encoded: OSStatus = chunk.withUnsafeBytes { input in
        var source = InputProxy(
          bytes: input.baseAddress,
          byteCount: UInt32(bytesPerFrame),
          bytesPerFrame: UInt32(bytesPerSourceFrame),
          consumed: false
        )
        return output.withUnsafeMutableBytes { outputBytes in
          var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
              mNumberChannels: destinationFormat.mChannelsPerFrame,
              mDataByteSize: UInt32(outputBytes.count),
              mData: outputBytes.baseAddress
            )
          )
          return withUnsafeMutablePointer(to: &source) { proxy in
            AudioConverterFillComplexBuffer(
              converter,
              inputCallback,
              proxy,
              &packetCount,
              &bufferList,
              &packetDescription
            )
          }
        }
      }

      guard encoded == noErr || encoded == kNoMoreDataError, packetCount > 0 else {
        if encoded != noErr { onFailure?(.converter(encoded)) }
        return
      }

      let size = Int(packetDescription.mDataByteSize)
      guard size > 0, size <= output.count else { return }

      onFrame?(EncodedAudioFrame(
        data: output.prefix(size),
        presentationTime: pendingTime,
        sampleRate: Int(destinationFormat.mSampleRate),
        channelCount: Int(destinationFormat.mChannelsPerFrame)
      ))
      pendingTime += Double(Self.samplesPerFrame) / destinationFormat.mSampleRate
    }
  }

  private func teardownLocked() {
    if let converter { AudioConverterDispose(converter) }
    converter = nil
    pending.removeAll(keepingCapacity: true)
    audioSpecificConfig = nil
  }
}

/// Marker the input callback returns when the one frame it holds has already been handed over.
private let kNoMoreDataError: OSStatus = -1

private struct InputProxy {
  let bytes: UnsafeRawPointer?
  let byteCount: UInt32
  let bytesPerFrame: UInt32
  var consumed: Bool
}

/// `AudioConverterFillComplexBuffer` pulls rather than pushes, so the pending frame is handed over
/// from here. It must be a C function pointer, which is why this is a free function.
private let inputCallback: AudioConverterComplexInputDataProc = {
  _, packetCount, bufferList, packetDescriptions, userData in
  guard let userData else {
    packetCount.pointee = 0
    return kNoMoreDataError
  }
  let proxy = userData.assumingMemoryBound(to: InputProxy.self)
  guard !proxy.pointee.consumed, let bytes = proxy.pointee.bytes else {
    packetCount.pointee = 0
    return kNoMoreDataError
  }

  proxy.pointee.consumed = true
  bufferList.pointee.mNumberBuffers = 1
  bufferList.pointee.mBuffers.mData = UnsafeMutableRawPointer(mutating: bytes)
  bufferList.pointee.mBuffers.mDataByteSize = proxy.pointee.byteCount
  bufferList.pointee.mBuffers.mNumberChannels = 1
  packetCount.pointee = proxy.pointee.byteCount / proxy.pointee.bytesPerFrame
  packetDescriptions?.pointee = nil
  return noErr
}
