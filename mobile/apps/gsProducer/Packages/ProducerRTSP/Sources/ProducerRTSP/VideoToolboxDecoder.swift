import CoreMedia
import CoreVideo
import Foundation
import ProducerSources
import VideoToolbox

/// Hardware decode of one camera's video, from length-prefixed access units to pixel buffers.
///
/// Both codecs are supported because the camera population is mixed: one H.264 at 720p and two
/// H.265 at 1080p. The two need different format-description constructors and different parameter
/// sets, so the codec is fixed when the session is built from the SDP.
///
/// Output is `420YpCbCr8BiPlanarVideoRange`, which is what `PixelConverter` already wants, so a
/// decoded frame reaches the compositor and the encoders with no conversion at all.
public final class VideoToolboxDecoder: @unchecked Sendable {
  public struct Statistics: Sendable, Equatable {
    public var decoded: UInt64 = 0
    public var failures: UInt64 = 0
    /// A mid-stream resolution or profile change, which forces a new session.
    public var formatChanges: UInt64 = 0
    public var droppedCorrupt: UInt64 = 0

    public init() {}
  }

  public typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime) -> Void

  public static let outputPixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

  public let codec: VideoCodec

  private let onFrame: FrameHandler
  private let lock = NSLock()
  private var session: VTDecompressionSession?
  private var formatDescription: CMVideoFormatDescription?
  private var parameterSets: [Data] = []
  private var statistics = Statistics()

  public init(codec: VideoCodec, onFrame: @escaping FrameHandler) {
    self.codec = codec
    self.onFrame = onFrame
  }

  deinit {
    if let session {
      VTDecompressionSessionInvalidate(session)
    }
  }

  public var currentStatistics: Statistics {
    lock.lock()
    defer { lock.unlock() }
    return statistics
  }

  public var isReady: Bool {
    lock.lock()
    defer { lock.unlock() }
    return session != nil
  }

  /// Installs decoder configuration, from the SDP at start-up and from the stream thereafter.
  ///
  /// Identical sets are ignored: these cameras repeat them before every keyframe, and rebuilding the
  /// session 30 times a minute would stall the picture each time.
  @discardableResult
  public func setParameterSets(_ sets: [Data]) -> Bool {
    let required = codec == .hevc ? 3 : 2
    guard sets.count >= required else { return false }

    lock.lock()
    if sets == parameterSets, session != nil {
      lock.unlock()
      return true
    }
    lock.unlock()

    guard let description = Self.makeFormatDescription(codec: codec, parameterSets: sets) else {
      lock.lock()
      statistics.failures &+= 1
      lock.unlock()
      return false
    }

    let created = Self.makeSession(formatDescription: description)
    lock.lock()
    let previous = session
    session = created
    formatDescription = description
    parameterSets = sets
    if previous != nil { statistics.formatChanges &+= 1 }
    lock.unlock()

    if let previous { VTDecompressionSessionInvalidate(previous) }
    return created != nil
  }

  /// Decodes one picture. Returns false when there was nothing decodable, which the caller counts
  /// as a format miss.
  @discardableResult
  public func decode(_ unit: VideoAccessUnit, presentationTime: CMTime) -> Bool {
    if !unit.parameterSets.isEmpty {
      setParameterSets(unit.parameterSets)
    }

    // A picture assembled across a packet loss decodes into visible corruption, so it is counted
    // and dropped rather than shown.
    if unit.isCorrupt {
      lock.lock()
      statistics.droppedCorrupt &+= 1
      lock.unlock()
      return false
    }
    guard !unit.data.isEmpty else { return false }

    lock.lock()
    let session = self.session
    let description = formatDescription
    lock.unlock()

    guard let session, let description else {
      // Parameter sets have not arrived yet. Normal for the first few packets of a stream that
      // starts mid-GOP, and it resolves at the next keyframe.
      return false
    }

    guard let sampleBuffer = Self.makeSampleBuffer(
      data: unit.data,
      formatDescription: description,
      presentationTime: presentationTime
    ) else {
      lock.lock()
      statistics.failures &+= 1
      lock.unlock()
      return false
    }

    let handler = onFrame
    let status = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sampleBuffer,
      flags: [],
      infoFlagsOut: nil
    ) { [weak self] status, _, imageBuffer, decodedPresentationTime, _ in
      guard let self else { return }
      guard status == noErr, let imageBuffer else {
        self.lock.lock()
        self.statistics.failures &+= 1
        self.lock.unlock()
        return
      }
      self.lock.lock()
      self.statistics.decoded &+= 1
      self.lock.unlock()
      handler(imageBuffer, decodedPresentationTime.isValid ? decodedPresentationTime : presentationTime)
    }

    guard status == noErr else {
      lock.lock()
      statistics.failures &+= 1
      lock.unlock()
      // A session that has gone bad stays bad; dropping it forces a rebuild on the next
      // parameter sets rather than failing every frame from here on.
      if status == kVTInvalidSessionErr {
        lock.lock()
        self.session = nil
        parameterSets = []
        lock.unlock()
        VTDecompressionSessionInvalidate(session)
      }
      return false
    }
    return true
  }

  public func invalidate() {
    lock.lock()
    let session = self.session
    self.session = nil
    formatDescription = nil
    parameterSets = []
    lock.unlock()

    if let session { VTDecompressionSessionInvalidate(session) }
  }

  // MARK: - Session construction

  static func makeFormatDescription(
    codec: VideoCodec,
    parameterSets sets: [Data]
  ) -> CMVideoFormatDescription? {
    CompressedSample.videoFormatDescription(codec: codec.compressed, parameterSets: sets)
  }

  private static func makeSession(
    formatDescription: CMVideoFormatDescription
  ) -> VTDecompressionSession? {
    let imageAttributes: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: outputPixelFormat,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      kCVPixelBufferMetalCompatibilityKey as String: true
    ]

    var session: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: formatDescription,
      decoderSpecification: nil,
      imageBufferAttributes: imageAttributes as CFDictionary,
      outputCallback: nil,
      decompressionSessionOut: &session
    )
    guard status == noErr, let session else { return nil }

    // Live video: latency matters more than smoothing, and this decode shares the media engine
    // with up to five encoders.
    VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    return session
  }

  private static func makeSampleBuffer(
    data: Data,
    formatDescription: CMVideoFormatDescription,
    presentationTime: CMTime
  ) -> CMSampleBuffer? {
    CompressedSample.videoSampleBuffer(
      data: data,
      formatDescription: formatDescription,
      presentationTime: presentationTime
    )
  }
}

public extension VideoCodec {
  var compressed: CompressedFrame.Codec {
    switch self {
    case .h264: .h264
    case .hevc: .hevc
    }
  }
}
