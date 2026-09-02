import CameramanCore
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Hardware H.264 / HEVC encoding.
///
/// Confined to one serial queue like the capture session, and it emits `EncodedVideoFrame` — plain
/// elementary NAL units — so the packetizers never see a `CMSampleBuffer` and can be tested on bytes.
public final class VideoEncoder: @unchecked Sendable {
  public enum Failure: Error, CustomStringConvertible {
    case sessionCreation(OSStatus)
    case encode(OSStatus)

    public var description: String {
      switch self {
      case .sessionCreation(let status): "could not create a compression session (\(status))"
      case .encode(let status): "encode failed (\(status))"
      }
    }
  }

  private static let queueKey = DispatchSpecificKey<UInt8>()
  private let queue = DispatchQueue(label: "co.gamestation.cameraman.encode")
  private var session: VTCompressionSession?
  private var settings: StreamSettings?
  private var parameterSets: [Data] = []
  private var blackPixelBuffer: CVPixelBuffer?
  /// Consumed by the next `encode` call. `kVTEncodeFrameOptionKey_ForceKeyFrame` is a per-frame
  /// option, not a session property, so it has to travel with `VTCompressionSessionEncodeFrame`.
  private var forceNextKeyframe = false

  /// Elementary-stream frames, delivered on the encoder queue.
  public var onFrame: (@Sendable (EncodedVideoFrame) -> Void)?
  public var onFailure: (@Sendable (Failure) -> Void)?

  public init() {
    queue.setSpecific(key: Self.queueKey, value: 1)
  }

  /// VideoToolbox often invokes the encode handler on its own thread, but `EncodeFrame` and
  /// `CompleteFrames` also call it synchronously on `queue`. Hop only when we are not already
  /// there, so teardown can still drain frames before `session` is cleared.
  private func runOnEncoderQueue(_ work: @escaping @Sendable () -> Void) {
    if DispatchQueue.getSpecific(key: Self.queueKey) != nil {
      work()
    } else {
      queue.async(execute: work)
    }
  }

  public func configure(settings: StreamSettings) {
    queue.async { [self] in
      teardownLocked()
      do {
        try createSession(settings: settings)
        self.settings = settings
      } catch let failure as Failure {
        onFailure?(failure)
      } catch {
        onFailure?(.sessionCreation(-1))
      }
    }
  }

  public func encode(_ sample: SampleBufferRef, blank: Bool = false) {
    queue.async { [self] in
      guard let session, let imageBuffer = CMSampleBufferGetImageBuffer(sample.buffer) else { return }
      let time = CMSampleBufferGetPresentationTimeStamp(sample.buffer)
      let toEncode: CVPixelBuffer
      if blank, let black = self.blackBuffer(matching: imageBuffer) {
        toEncode = black
      } else {
        toEncode = imageBuffer
      }
      var frameProperties: CFDictionary?
      let requestedKeyframe = forceNextKeyframe
      if requestedKeyframe {
        forceNextKeyframe = false
        frameProperties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
      }
      let status = VTCompressionSessionEncodeFrame(
        session,
        imageBuffer: toEncode,
        presentationTimeStamp: time,
        duration: CMSampleBufferGetDuration(sample.buffer),
        frameProperties: frameProperties,
        infoFlagsOut: nil
      ) { [weak self] status, _, buffer in
        guard let self else { return }
        self.runOnEncoderQueue { [self] in
          guard session != nil else { return }
          guard status == noErr, let buffer else {
            onFailure?(.encode(status))
            return
          }
          emit(buffer)
        }
      }
      if status != noErr {
        // The frame never entered the session, so the next encode should still try to IDR.
        if requestedKeyframe { forceNextKeyframe = true }
        onFailure?(.encode(status))
      }
    }
  }

  /// Forces the next frame to be a keyframe. A client that joins between keyframes otherwise waits
  /// out the whole interval showing nothing.
  public func requestKeyframe() {
    queue.async { [self] in
      guard session != nil else { return }
      forceNextKeyframe = true
    }
  }

  public func setBitrate(_ bitrate: Int) {
    queue.async { [self] in
      guard let session else { return }
      VTSessionSetProperty(
        session,
        key: kVTCompressionPropertyKey_AverageBitRate,
        value: NSNumber(value: bitrate)
      )
      // The data-rate cap has to move with the average or a raised bitrate is silently held down by
      // a stale ceiling.
      VTSessionSetProperty(
        session,
        key: kVTCompressionPropertyKey_DataRateLimits,
        value: Self.dataRateLimits(bitrate: bitrate)
      )
    }
  }

  public func invalidate() {
    queue.async { [self] in teardownLocked() }
  }

  // MARK: - Session

  private func createSession(settings: StreamSettings) throws {
    let codec: CMVideoCodecType = settings.codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264
    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(settings.width),
      height: Int32(settings.height),
      codecType: codec,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &created
    )
    guard status == noErr, let created else { throw Failure.sessionCreation(status) }

    let properties: [(CFString, CFTypeRef)] = [
      // Live streaming, not file export: never trade latency for compression.
      (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
      // B-frames would reorder output, which forces either a reordering buffer or wrong RTP
      // timestamps. Neither is worth the few percent of bitrate.
      (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
      (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: settings.bitrate)),
      (kVTCompressionPropertyKey_DataRateLimits, Self.dataRateLimits(bitrate: settings.bitrate)),
      (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: settings.frameRate)),
      // One keyframe a second. A client joining a stream waits at most that long for a picture, and
      // it bounds how much a lost keyframe costs.
      (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: Int(settings.frameRate.rounded()))),
      (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: 1.0)),
      (kVTCompressionPropertyKey_ProfileLevel, Self.profileLevel(for: settings.codec))
    ]
    for (key, value) in properties {
      VTSessionSetProperty(created, key: key, value: value)
    }
    VTCompressionSessionPrepareToEncodeFrames(created)
    session = created
  }

  private func teardownLocked() {
    guard let session else { return }
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    VTCompressionSessionInvalidate(session)
    self.session = nil
    parameterSets = []
    forceNextKeyframe = false
    blackPixelBuffer = nil
  }

  private func blackBuffer(matching imageBuffer: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(imageBuffer)
    let height = CVPixelBufferGetHeight(imageBuffer)
    let format = CVPixelBufferGetPixelFormatType(imageBuffer)
    if let existing = blackPixelBuffer,
      CVPixelBufferGetWidth(existing) == width,
      CVPixelBufferGetHeight(existing) == height,
      CVPixelBufferGetPixelFormatType(existing) == format
    {
      return existing
    }
    var created: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      format,
      nil,
      &created
    )
    guard status == kCVReturnSuccess, let created else { return nil }
    Self.fillBlack(created)
    blackPixelBuffer = created
    return created
  }

  private static func fillBlack(_ buffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let format = CVPixelBufferGetPixelFormatType(buffer)
    let videoRange = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    let biplanar = videoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    if biplanar {
      if let y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
          * CVPixelBufferGetHeightOfPlane(buffer, 0)
        y.assumingMemoryBound(to: UInt8.self).update(repeating: videoRange ? 16 : 0, count: bytes)
      }
      if let uv = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
          * CVPixelBufferGetHeightOfPlane(buffer, 1)
        uv.assumingMemoryBound(to: UInt8.self).update(repeating: 128, count: bytes)
      }
      return
    }
    if let base = CVPixelBufferGetBaseAddress(buffer) {
      let bytes = CVPixelBufferGetBytesPerRow(buffer) * CVPixelBufferGetHeight(buffer)
      base.assumingMemoryBound(to: UInt8.self).update(repeating: 0, count: bytes)
    }
  }

  private func emit(_ buffer: CMSampleBuffer) {
    guard let codec = settings?.codec,
          let dataBuffer = CMSampleBufferGetDataBuffer(buffer)
    else { return }

    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(
      dataBuffer,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &length,
      dataPointerOut: &pointer
    ) == noErr, let pointer else { return }

    let avcc = Data(bytes: pointer, count: length)
    // VideoToolbox declares the length size per format; assuming 4 would misread a stream that used
    // 2, and the frame would decode as garbage rather than fail.
    let lengthSize = Self.lengthSize(of: buffer)
    guard let units = NALUnitConversion.elementaryUnits(fromAVCC: avcc, lengthSize: lengthSize) else {
      return
    }

    let isKeyframe = Self.isKeyframe(buffer)
    if isKeyframe, let description = CMSampleBufferGetFormatDescription(buffer) {
      parameterSets = ParameterSets.extract(from: description, codec: codec)
    }

    onFrame?(EncodedVideoFrame(
      nalUnits: units,
      // Repeated on every keyframe, so a client that joined mid-stream recovers without a new
      // DESCRIBE.
      parameterSets: isKeyframe ? parameterSets : [],
      isKeyframe: isKeyframe,
      presentationTime: CMSampleBufferGetPresentationTimeStamp(buffer).seconds
    ))
  }

  /// The current decoder configuration, for the SDP. Empty until the first keyframe is encoded.
  public func currentParameterSets() -> [Data] {
    queue.sync { parameterSets }
  }

  static func lengthSize(of buffer: CMSampleBuffer) -> Int {
    guard let description = CMSampleBufferGetFormatDescription(buffer) else { return 4 }
    var size: Int32 = 4
    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      description,
      parameterSetIndex: 0,
      parameterSetPointerOut: nil,
      parameterSetSizeOut: nil,
      parameterSetCountOut: nil,
      nalUnitHeaderLengthOut: &size
    ) != noErr {
      CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        description,
        parameterSetIndex: 0,
        parameterSetPointerOut: nil,
        parameterSetSizeOut: nil,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: &size
      )
    }
    return Int(size)
  }

  static func isKeyframe(_ buffer: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false),
          let first = (attachments as NSArray).firstObject as? NSDictionary
    else {
      // No attachments at all means nothing marked this frame as depending on others, so it is one.
      return true
    }
    // `NotSync` is the negative: its absence, or false, means this is a sync sample.
    let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
    return !notSync
  }

  /// A hard ceiling one second wide at 1.5x the average. Without it a busy scene produces a burst
  /// several times the nominal rate, which is exactly when a phone's uplink is least able to carry it.
  static func dataRateLimits(bitrate: Int) -> CFArray {
    let bytesPerSecond = Double(bitrate) / 8 * 1.5
    return [ bytesPerSecond, 1.0 ] as CFArray
  }

  static func profileLevel(for codec: StreamCodec) -> CFString {
    switch codec {
    // High profile is what every RTSP client in this project already decodes, and it is worth
    // several percent of bitrate over baseline.
    case .h264: kVTProfileLevel_H264_High_AutoLevel
    case .hevc: kVTProfileLevel_HEVC_Main_AutoLevel
    }
  }
}

/// The encoder's own hand-off box, so `CameramanEncode` does not depend on `CameramanCapture`.
public struct SampleBufferRef: @unchecked Sendable {
  public let buffer: CMSampleBuffer

  public init(_ buffer: CMSampleBuffer) {
    self.buffer = buffer
  }
}
