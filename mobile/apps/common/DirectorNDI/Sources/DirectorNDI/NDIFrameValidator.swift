import CNDI
import Foundation

/// What a frame has to be before anything downstream is allowed to see it.
///
/// NDI's transport already repairs the wire — reliable UDP with retransmission — so the corruption
/// a receiver actually meets is not torn packets but *structurally wrong frames*: a sender that
/// changed resolution without saying so, a stride that does not cover its own row, a frame rate
/// with a zero denominator, an Advanced-SDK sender handing us compressed data this SDK cannot
/// decode. Every one of those reaches `NDIlib_recv_capture_v3` looking like a perfectly ordinary
/// success.
///
/// So this is the filter, and it is deliberately a pure function over the frame header: no state,
/// no I/O, and therefore testable without a network. Each rejection names *which* rule fired,
/// because a frame refused for the wrong reason hides the one that mattered.
public enum NDIFrameValidator {
  /// The largest picture this app receives. 4K is out of scope, and a 4K frame accepted here would
  /// be discovered as a thermal problem in the middle of a game rather than as a refusal in the
  /// source list.
  public static let maximumWidth = 1920
  public static let maximumHeight = 1080
  /// Outside this, a frame rate is a corrupt header rather than a format. 120 leaves room for a
  /// camera offering 119.88 without letting a garbage numerator through.
  public static let minimumFrameRate = 1.0
  public static let maximumFrameRate = 120.0

  public enum VideoRejection: String, Sendable, Equatable {
    case emptyDimensions
    case oddWidth
    case tooLarge
    case nullData
    case unsupportedFourCC
    case shortStride
    case invalidFrameRate
    case fielded

    /// What the tile says. Written for an operator, not a log reader — every one of these is a
    /// camera that will never appear, and "nothing happened" is the worst possible answer.
    public var reason: String {
      switch self {
      case .emptyDimensions: "camera sent a frame with no picture in it"
      case .oddWidth: "camera sent an odd frame width, which 4:2:2 cannot carry"
      case .tooLarge: "camera is above 1080p; this app does not receive 4K"
      case .nullData: "camera sent compressed video, which needs the NDI Advanced SDK"
      case .unsupportedFourCC: "camera sent a pixel format this app does not read"
      case .shortStride: "camera sent a row stride shorter than its own picture"
      case .invalidFrameRate: "camera sent an impossible frame rate"
      case .fielded: "camera sent interlaced fields, which this app does not archive"
      }
    }
  }

  public enum AudioRejection: String, Sendable, Equatable {
    case invalidSampleRate
    case invalidChannelCount
    case emptyBuffer
    case nullData
    case unsupportedFourCC
    case shortChannelStride

    public var reason: String {
      switch self {
      case .invalidSampleRate: "camera sent audio with no sample rate"
      case .invalidChannelCount: "camera sent audio with no channels"
      case .emptyBuffer: "camera sent an empty audio buffer"
      case .nullData: "camera sent audio with no samples in it"
      case .unsupportedFourCC: "camera sent an audio format this app does not read"
      case .shortChannelStride: "camera sent an audio channel stride shorter than its own samples"
      }
    }
  }

  /// Pixel layouts this app converts. Everything else is refused rather than guessed at.
  ///
  /// The receiver asks for `NDIlib_recv_color_format_fastest`, so UYVY is what almost every camera
  /// produces; the 4:2:0 layouts appear from NDI|HX senders, and BGRA/RGBA from software senders
  /// such as a screen capture.
  ///
  /// UYVA is accepted and its alpha plane ignored. `fastest` hands back UYVA rather than UYVY
  /// whenever the *sender* declares an alpha channel — which a graphics feed routinely does — and
  /// the colour plane in front of that alpha is ordinary UYVY. Refusing it would show a black tile
  /// for a stream that reads perfectly well.
  ///
  /// The 16-bit formats (P216, PA16) stay out: this pipeline is 8-bit 4:2:0 end to end, so
  /// converting them would cost a pass per frame to throw the extra precision away.
  public static func isSupported(_ fourCC: NDIlib_FourCC_video_type_e) -> Bool {
    switch fourCC {
    case NDIlib_FourCC_video_type_UYVY,
         NDIlib_FourCC_video_type_UYVA,
         NDIlib_FourCC_video_type_NV12,
         NDIlib_FourCC_video_type_I420,
         NDIlib_FourCC_video_type_YV12,
         NDIlib_FourCC_video_type_BGRA,
         NDIlib_FourCC_video_type_BGRX,
         NDIlib_FourCC_video_type_RGBA,
         NDIlib_FourCC_video_type_RGBX:
      true
    default:
      false
    }
  }

  /// Bytes one row of this layout needs. 4:2:0 and 4:2:2 both start with a full-width 8-bit luma
  /// row, which is why the plane maths below all key off `xres`.
  static func minimumStride(for fourCC: NDIlib_FourCC_video_type_e, width: Int) -> Int {
    switch fourCC {
    case NDIlib_FourCC_video_type_UYVY, NDIlib_FourCC_video_type_UYVA: width * 2
    case NDIlib_FourCC_video_type_NV12,
         NDIlib_FourCC_video_type_I420,
         NDIlib_FourCC_video_type_YV12: width
    case NDIlib_FourCC_video_type_BGRA,
         NDIlib_FourCC_video_type_BGRX,
         NDIlib_FourCC_video_type_RGBA,
         NDIlib_FourCC_video_type_RGBX: width * 4
    default: width * 4
    }
  }

  public static func accept(_ frame: NDIlib_video_frame_v2_t) -> VideoRejection? {
    guard frame.xres > 0, frame.yres > 0 else { return .emptyDimensions }
    // "Because data is internally all considered in 4:2:2 formats, image width values should be
    // divisible by two." An odd width makes every chroma plane calculation below off by a column.
    guard frame.xres % 2 == 0 else { return .oddWidth }
    guard frame.xres <= maximumWidth, frame.yres <= maximumHeight else { return .tooLarge }

    // A frame with dimensions but no pixels is how an Advanced-SDK sender delivers compressed
    // video. There is nothing wrong with the frame; this SDK simply cannot decode it, and saying
    // so is far more useful than a black tile.
    guard frame.p_data != nil else { return .nullData }
    guard isSupported(frame.FourCC) else { return .unsupportedFourCC }

    let stride = Int(frame.line_stride_in_bytes)
    guard stride >= minimumStride(for: frame.FourCC, width: Int(frame.xres)) else {
      return .shortStride
    }

    guard frame.frame_rate_N > 0, frame.frame_rate_D > 0 else { return .invalidFrameRate }
    let rate = Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
    guard rate >= minimumFrameRate, rate <= maximumFrameRate else { return .invalidFrameRate }

    // The receiver is created with `allow_video_fields = false`, so the SDK de-interlaces for us.
    // A fielded frame arriving anyway is a sender ignoring that, and half a picture written into a
    // progressive archive is worse than no picture.
    switch frame.frame_format_type {
    case NDIlib_frame_format_type_progressive: break
    default: return .fielded
    }

    return nil
  }

  public static func accept(_ frame: NDIlib_audio_frame_v3_t) -> AudioRejection? {
    guard frame.sample_rate > 0 else { return .invalidSampleRate }
    guard frame.no_channels > 0 else { return .invalidChannelCount }
    guard frame.no_samples > 0 else { return .emptyBuffer }
    guard frame.p_data != nil else { return .nullData }
    guard frame.FourCC == NDIlib_FourCC_audio_type_FLTP else { return .unsupportedFourCC }
    guard Int(frame.channel_stride_in_bytes) >= Int(frame.no_samples) * MemoryLayout<Float>.size else {
      return .shortChannelStride
    }
    return nil
  }

  /// Whether a metadata payload is worth parsing.
  ///
  /// The SDK documentation is explicit that receivers must tolerate badly formed XML, so this
  /// never throws and never rejects a *frame* — it only decides whether to look inside. A sender
  /// with a broken product string is still a working camera.
  public static func isWellFormedXML(_ string: String) -> Bool {
    guard !string.isEmpty else { return false }
    final class Sink: NSObject, XMLParserDelegate {
      var failed = false
      func parser(_ parser: XMLParser, parseErrorOccurred: Error) { failed = true }
    }
    guard let data = string.data(using: .utf8) else { return false }
    let parser = XMLParser(data: data)
    let sink = Sink()
    parser.delegate = sink
    return parser.parse() && !sink.failed
  }
}

/// Every reason a frame was thrown away this session, so `/dump-state` can say which rule fired
/// rather than only that something did.
public struct NDIRejectionCounters: Sendable, Equatable {
  public var video: [String: UInt64] = [:]
  public var audio: [String: UInt64] = [:]
  public var malformedMetadata: UInt64 = 0

  public init() {}

  public var totalVideo: UInt64 { video.values.reduce(0, +) }
  public var totalAudio: UInt64 { audio.values.reduce(0, +) }

  mutating func record(_ rejection: NDIFrameValidator.VideoRejection) {
    video[rejection.rawValue, default: 0] += 1
  }

  mutating func record(_ rejection: NDIFrameValidator.AudioRejection) {
    audio[rejection.rawValue, default: 0] += 1
  }

  /// `tooLarge=3 shortStride=1`, in a stable order so a test can assert on it.
  public var summary: String {
    let parts = (video.map { ($0.key, $0.value) } + audio.map { ($0.key, $0.value) })
      .sorted { $0.0 < $1.0 }
      .map { "\($0.0)=\($0.1)" }
    return parts.joined(separator: " ")
  }
}
