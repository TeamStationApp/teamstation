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

  private let queue = DispatchQueue(label: "app.teamstation.cameraman.audio")
  private var converter: AudioConverterRef?
  private var sourceFormat = AudioStreamBasicDescription()
  private var destinationFormat = AudioStreamBasicDescription()
  private var pcmPending = PCMPendingBuffer()
  /// Where the first sample waiting in `pcmPending` sits on the sample-count timeline: set from the
  /// first buffer's capture time, then only ever counted on. A stretch the microphone lost is not on
  /// it; `captureAnchors` carries the jump onto the capture clock.
  private var pendingTime: Double = 0
  /// Whether `pendingTime` has been set since the converter was made.
  private var hasTimeline = false
  /// Where each 1024-sample chunk handed to the converter began, oldest first, until the access unit
  /// it is the start of comes out. The converter can hold a chunk or two before its first packet,
  /// and how many varies; matching packets to chunks in order, rather than counting packets from
  /// where the input began, keeps every access unit at its own samples' time.
  private var chunkTimes: [Double] = []
  /// The encoder's priming: a packet's decoded sound is the input from this long before the chunk
  /// it was cut against. 2,112 samples for Apple's AAC-LC, read from the converter.
  private var primingSeconds: Double = 0
  /// Recent capture buffers: where each one's first sample sits on the sample-count timeline, and
  /// when it was captured. A frame's capture time comes from the latest buffer at or before its own
  /// position, moved by how far into it the frame starts. The newest buffer alone is wrong for a
  /// frame cut from samples queued before it, which is exactly the frame beside a dropped stretch.
  private var captureAnchors: [(position: Double, capture: Double)] = []
  private var bytesPerSourceFrame = 0
  private var wasSilent = false
  /// Last non-empty silent access unit. The converter can return a 0-byte packet for zeros
  /// (DTX); the archive still needs one AU per 1024 samples or the mute becomes a squeeze.
  private var silentAU: Data?

  /// Eight AAC frames is 170 ms of PCM. Anything more is the converter falling behind.
  private static let maxBufferedFrames = 8

  /// The `AudioSpecificConfig` for the SDP's `config=`. Known before the first packet, because it
  /// depends only on the negotiated format.
  public private(set) var audioSpecificConfig: Data?

  /// Bytes of PCM still waiting for a 1024-sample AAC frame. Soak telemetry reads this.
  public var pendingBytes: Int {
    queue.sync { pcmPending.readableCount }
  }

  public var onFrame: (@Sendable (EncodedAudioFrame) -> Void)?
  public var onFailure: (@Sendable (Failure) -> Void)?

  /// AAC-LC always codes 1024 samples per access unit, which is also what the RTP timestamp step is.
  public static let samplesPerFrame = 1024
  /// Apple's AAC-LC encoder priming, used if the converter will not say.
  static let defaultPrimingSamples = 2_112

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
      var prime = AudioConverterPrimeInfo()
      var primeSize = UInt32(MemoryLayout<AudioConverterPrimeInfo>.size)
      let leading = AudioConverterGetProperty(created, kAudioConverterPrimeInfo, &primeSize, &prime) == noErr
        ? Double(prime.leadingFrames)
        : Double(Self.defaultPrimingSamples)
      primingSeconds = leading / Double(sampleRate)
      audioSpecificConfig = config
      silentAU = encodeAccessUnit(Data(count: Self.samplesPerFrame * bytesPerSourceFrame))
    }
  }

  public func encode(_ sample: SampleBufferRef, silent: Bool = false) {
    // Copy PCM here so the audio queue does not retain `CMSampleBuffer`s if drain falls behind.
    guard let block = CMSampleBufferGetDataBuffer(sample.buffer) else { return }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(
      block,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &length,
      dataPointerOut: &pointer
    ) == noErr, let pointer, length > 0 else { return }

    let pcm = silent ? Data(count: length) : Data(bytes: pointer, count: length)
    let pts = CMSampleBufferGetPresentationTimeStamp(sample.buffer).seconds
    queue.async { [self] in
      guard converter != nil else { return }
      if silent && !wasSilent {
        pcmPending.replaceReadableWithZeros()
        if let converter { AudioConverterReset(converter) }
        // What the converter held is gone with the reset.
        chunkTimes.removeAll()
      }
      wasSilent = silent
      // Once only. Restarting the count at each buffer's capture time whenever the queue happened
      // to be empty put a lost stretch into the count, and a packet the converter still held from
      // before the gap was stamped after it: up to the gap late, as was the sender report it was
      // paired into, and with it every sound placed by that report.
      if !hasTimeline, pts.isFinite {
        pendingTime = pts
        hasTimeline = true
      }
      if pts.isFinite, bytesPerSourceFrame > 0, sourceFormat.mSampleRate > 0 {
        let queued = Double(pcmPending.readableCount / bytesPerSourceFrame) / sourceFormat.mSampleRate
        captureAnchors.append((position: pendingTime + queued, capture: pts))
        if captureAnchors.count > 64 { captureAnchors.removeFirst(captureAnchors.count - 64) }
      }
      pcmPending.append(pcm)
      dropIfBackedUp()
      drain(silent: silent)
      pcmPending.compactIfNeeded()
    }
  }

  public func invalidate() {
    queue.async { [self] in teardownLocked() }
  }

  /// The converter needs whole 1024-sample frames, and a capture callback delivers whatever the
  /// hardware felt like. Anything short of a frame is held over rather than padded with silence,
  /// which would put a click into the stream every buffer boundary.
  private func drain(silent: Bool) {
    guard bytesPerSourceFrame > 0 else { return }
    let bytesPerFrame = Self.samplesPerFrame * bytesPerSourceFrame

    let chunkSeconds = Double(Self.samplesPerFrame) / destinationFormat.mSampleRate
    while let chunk = pcmPending.take(bytesPerFrame) {
      chunkTimes.append(pendingTime)
      if chunkTimes.count > 16 { chunkTimes.removeFirst(chunkTimes.count - 16) }
      pendingTime += chunkSeconds
      var encoded = encodeAccessUnit(chunk)
      if silent {
        if let encoded, !encoded.isEmpty { silentAU = encoded }
        if encoded == nil || encoded?.isEmpty == true { encoded = silentAU }
      }
      // A converter still filling its delay gives no packet yet; the chunk waits for the one it
      // starts.
      guard let encoded, !encoded.isEmpty else { continue }

      // The packet's decoded sound is the input from the priming before its chunk: stamped there,
      // it plays with the pictures captured with it. Stamped at the chunk, every iPhone's sound
      // sat 44 ms late, plus 21 ms for each chunk the converter held at the start of a session.
      let chunkTime = chunkTimes.isEmpty ? pendingTime - chunkSeconds : chunkTimes.removeFirst()
      let time = chunkTime - primingSeconds
      onFrame?(EncodedAudioFrame(
        data: encoded,
        presentationTime: time,
        sampleRate: Int(destinationFormat.mSampleRate),
        channelCount: Int(destinationFormat.mChannelsPerFrame),
        captureTime: captureTime(at: time)
      ))
    }
  }

  private func captureTime(at position: Double) -> Double? {
    guard let anchor = captureAnchors.last(where: { $0.position <= position + 1e-6 }) ?? captureAnchors.first
    else { return nil }
    return anchor.capture + (position - anchor.position)
  }

  private func encodeAccessUnit(_ pcm: Data) -> Data? {
    guard let converter, bytesPerSourceFrame > 0 else { return nil }
    let bytesPerFrame = Self.samplesPerFrame * bytesPerSourceFrame
    guard pcm.count == bytesPerFrame else { return nil }

    var output = Data(count: 2048)
    var packetCount: UInt32 = 1
    var packetDescription = AudioStreamPacketDescription()

    let status: OSStatus = pcm.withUnsafeBytes { input in
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

    guard status == noErr || status == kNoMoreDataError, packetCount > 0 else {
      if status != noErr, status != kNoMoreDataError { onFailure?(.converter(status)) }
      return nil
    }

    let size = Int(packetDescription.mDataByteSize)
    guard size > 0, size <= output.count else { return nil }
    return Data(output.prefix(size))
  }

  private func teardownLocked() {
    captureAnchors.removeAll()
    chunkTimes.removeAll()
    primingSeconds = 0
    if let converter { AudioConverterDispose(converter) }
    converter = nil
    pcmPending.reset()
    pendingTime = 0
    hasTimeline = false
    audioSpecificConfig = nil
    wasSilent = false
    silentAU = nil
  }

  /// Eight AAC frames is 170 ms of PCM. Anything more is the converter falling behind, which is
  /// how this buffer used to grow at the microphone's byte rate until jetsam.
  private func dropIfBackedUp() {
    guard bytesPerSourceFrame > 0 else { return }
    let bytesPerFrame = Self.samplesPerFrame * bytesPerSourceFrame
    let maxBytes = bytesPerFrame * Self.maxBufferedFrames
    let extra = pcmPending.readableCount - maxBytes
    guard extra > 0 else { return }
    let drop = extra - (extra % bytesPerFrame)
    guard drop > 0 else { return }
    pcmPending.skip(drop)
    pendingTime += Double(drop / bytesPerSourceFrame) / destinationFormat.mSampleRate
    pcmPending.compactIfNeeded()
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
