import CoreMedia
import CoreVideo
import Foundation
import DirectorSources
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
    /// Sessions thrown away because they had stopped decoding, and the `OSStatus` that said so.
    /// A decoder that fails every frame from here on looks exactly like a camera that went quiet,
    /// and until these existed there was no way to tell those apart from outside.
    public var rebuilds: UInt64 = 0
    public var lastFailureStatus: Int = 0
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
  /// Bumped every time a session is installed. New parameter sets replace the session and
  /// invalidate the old one, whose in-flight frames may still come back through the callback with
  /// `kVTInvalidSessionErr`; without this those reports would tear down the *new* session and cost
  /// a rebuild plus the pictures until the next parameter sets, on every format change.
  private var sessionGeneration: UInt64 = 0
  private var formatDescription: CMVideoFormatDescription?
  private var parameterSets: [Data] = []
  private var statistics = Statistics()

  public init(codec: VideoCodec, onFrame: @escaping FrameHandler) {
    self.codec = codec
    self.onFrame = onFrame
  }

  /// Presentation time for one in-flight decode. Retained as `frameRefCon` until the C callback
  /// (or a failed `DecodeFrame`) releases it.
  fileprivate final class DecodeFrameToken {
    let presentationTime: CMTime
    /// Which session this frame went into. A failure reported for it is that session's, and must
    /// not retire whichever session is current by the time the report arrives.
    let generation: UInt64
    init(presentationTime: CMTime, generation: UInt64) {
      self.presentationTime = presentationTime
      self.generation = generation
    }
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

    let created = makeSession(formatDescription: description)
    lock.lock()
    let previous = session
    session = created
    sessionGeneration &+= 1
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
    let generation = sessionGeneration
    let description = formatDescription
    lock.unlock()

    guard let session, let description else {
      // Parameter sets have not arrived yet. Normal for the first few packets of a stream that
      // starts mid-GOP, and it resolves at the next keyframe.
      return false
    }

    return autoreleasepool {
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

      // The block-based DecodeFrame copies a Swift closure per picture. VideoToolbox has been
      // observed to retain those handlers (and their sample buffers) for the life of the session,
      // which grows with compressed bitrate. The C callback record is one function pointer.
      let token = DecodeFrameToken(presentationTime: presentationTime, generation: generation)
      let tokenPointer = Unmanaged.passRetained(token).toOpaque()
      var infoFlags: VTDecodeInfoFlags = []
      let status = VTDecompressionSessionDecodeFrame(
        session,
        sampleBuffer: sampleBuffer,
        flags: [],
        frameRefcon: tokenPointer,
        infoFlagsOut: &infoFlags
      )

      guard status == noErr else {
        _ = Unmanaged<DecodeFrameToken>.fromOpaque(tokenPointer).takeRetainedValue()
        lock.lock()
        statistics.failures &+= 1
        statistics.lastFailureStatus = Int(status)
        lock.unlock()
        // A session that has gone bad stays bad; dropping it forces a rebuild on the next
        // parameter sets rather than failing every frame from here on.
        //
        // A malfunction counts as bad. Only `kVTInvalidSessionErr` used to, and a decoder that
        // came back malfunctioning stayed in place failing every frame for the rest of the run —
        // measured on the bench with two 1080p60 NDI archives encoding alongside it, where the
        // RTSP preview died and never returned while its archive, which needs no decoder, kept
        // writing perfectly.
        // Only if the session that refused is still the one installed: a refusal from a session
        // that new parameter sets have already replaced says nothing about its successor.
        lock.lock()
        let retire = Self.isPermanent(status) && self.session === session
        if retire {
          self.session = nil
          parameterSets = []
          statistics.rebuilds &+= 1
        }
        lock.unlock()
        if retire { VTDecompressionSessionInvalidate(session) }
        return false
      }
      return true
    }
  }

  fileprivate func handleDecoded(
    status: OSStatus,
    imageBuffer: CVImageBuffer?,
    presentationTime: CMTime,
    generation: UInt64
  ) {
    guard status == noErr, let imageBuffer else {
      lock.lock()
      statistics.failures &+= 1
      statistics.lastFailureStatus = Int(status)
      // The session reports most of its trouble here rather than from the submit call, which is
      // where this was missed: submissions kept returning `noErr` while every frame came back
      // failed, so nothing ever decided the session was finished. Measured on the bench, an RTSP
      // camera reached 314 consecutive failures with the session still in place.
      //
      // Only the reference is dropped, and deliberately: this runs inside the session's own output
      // callback, and tearing a session down from within its callback is not something VideoToolbox
      // promises to survive. Releasing it lets it go when it is safe to, and the next parameter
      // sets build a fresh one.
      if Self.isPermanent(status), session != nil, generation == sessionGeneration {
        session = nil
        parameterSets = []
        statistics.rebuilds &+= 1
      }
      lock.unlock()
      return
    }
    lock.lock()
    statistics.decoded &+= 1
    lock.unlock()
    onFrame(imageBuffer, presentationTime)
  }

  /// Whether a decode failure is the session's condition rather than one bad frame. Corrupt data
  /// must not count: a damaged frame is ordinary on a live network and throwing the session away
  /// for one would mean rebuilding constantly and dropping the pictures in flight each time.
  static func isPermanent(_ status: OSStatus) -> Bool {
    status == kVTInvalidSessionErr
      || status == kVTVideoDecoderMalfunctionErr
      || status == kVTVideoDecoderNotAvailableNowErr
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

  private func makeSession(
    formatDescription: CMVideoFormatDescription
  ) -> VTDecompressionSession? {
    let imageAttributes: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: Self.outputPixelFormat,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      kCVPixelBufferMetalCompatibilityKey as String: true
    ]

    var callback = VTDecompressionOutputCallbackRecord(
      decompressionOutputCallback: videoToolboxDecompressionCallback,
      decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque()
    )
    var session: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: formatDescription,
      decoderSpecification: nil,
      imageBufferAttributes: imageAttributes as CFDictionary,
      outputCallback: &callback,
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

private func videoToolboxDecompressionCallback(
  decompressionOutputRefCon: UnsafeMutableRawPointer?,
  sourceFrameRefCon: UnsafeMutableRawPointer?,
  status: OSStatus,
  infoFlags: VTDecodeInfoFlags,
  imageBuffer: CVImageBuffer?,
  presentationTimeStamp: CMTime,
  presentationDuration: CMTime
) {
  var presentationTime = presentationTimeStamp
  var generation: UInt64 = 0
  if let sourceFrameRefCon {
    let token = Unmanaged<VideoToolboxDecoder.DecodeFrameToken>
      .fromOpaque(sourceFrameRefCon)
      .takeRetainedValue()
    generation = token.generation
    if !presentationTime.isValid {
      presentationTime = token.presentationTime
    }
  }
  guard let decompressionOutputRefCon else { return }
  let decoder = Unmanaged<VideoToolboxDecoder>
    .fromOpaque(decompressionOutputRefCon)
    .takeUnretainedValue()
  autoreleasepool {
    decoder.handleDecoded(
      status: status,
      imageBuffer: imageBuffer,
      presentationTime: presentationTime,
      generation: generation
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
