import Foundation

public enum StreamCodec: String, Sendable, Codable, Equatable, CaseIterable {
  case h264
  case hevc

  /// The SDP encoding name. `H265` rather than `HEVC` because that is what GS Producer's
  /// `SDPDescription.videoCodec` matches first, and what ffmpeg and VLC expect.
  public var sdpEncodingName: String {
    switch self {
    case .h264: "H264"
    case .hevc: "H265"
    }
  }

  /// HEVC buys roughly the same picture at two thirds the rate, so the defaults differ.
  public var defaultBitrate: Int {
    switch self {
    case .h264: 6_000_000
    case .hevc: 4_000_000
    }
  }
}

/// Everything the operator can change about the outgoing stream.
public struct StreamSettings: Sendable, Codable, Equatable {
  public static let canonicalPath = "/live/mainstream"
  public static let defaultPort = 554
  /// Used when 554 cannot be bound, which has been reported on the simulator.
  public static let fallbackPort = 8554

  public var width: Int
  public var height: Int
  public var frameRate: Double
  public var codec: StreamCodec
  public var bitrate: Int
  public var port: Int
  public var path: String
  public var audioEnabled: Bool
  /// When false the encoder still runs, but every picture is black so Director keeps a continuous
  /// video clock (and live audio) instead of treating a hole as a missing camera.
  public var videoEnabled: Bool
  public var audioSampleRate: Int
  /// Unique IDs of lenses the operator turned off. Empty means every detected lens is eligible,
  /// including ones that appear on a later handset.
  public var disabledLensIDs: Set<String>
  /// Which camera the operator last framed with, and at what zoom. Persisted because a camera on a
  /// tripod is aimed once: coming back on the wrong lens at 1x after a restart silently changes the
  /// shot, and on a fixed rig nobody is standing there to notice.
  public var cameraPosition: CameraPosition
  public var displayedZoom: Double

  public init(
    width: Int = 1920,
    height: Int = 1080,
    frameRate: Double = 30,
    codec: StreamCodec = .hevc,
    bitrate: Int = StreamCodec.hevc.defaultBitrate,
    port: Int = StreamSettings.defaultPort,
    path: String = StreamSettings.canonicalPath,
    audioEnabled: Bool = true,
    videoEnabled: Bool = true,
    audioSampleRate: Int = 48_000,
    disabledLensIDs: Set<String> = [],
    cameraPosition: CameraPosition = .back,
    displayedZoom: Double = 1
  ) {
    self.width = width
    self.height = height
    self.frameRate = frameRate
    self.codec = codec
    self.bitrate = bitrate
    self.port = port
    self.path = path
    self.audioEnabled = audioEnabled
    self.videoEnabled = videoEnabled
    self.audioSampleRate = audioSampleRate
    self.cameraPosition = cameraPosition
    self.displayedZoom = displayedZoom
    self.disabledLensIDs = disabledLensIDs
  }

  /// Decoded field by field with defaults for anything absent.
  ///
  /// `StreamSettingsStore.load()` treats a decode failure as "never configured" and falls back to
  /// defaults, so with the synthesised decoder every future field added here would silently reset
  /// every operator setting on upgrade. Tolerating missing keys makes that impossible.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let d = StreamSettings()
    width = try c.decodeIfPresent(Int.self, forKey: .width) ?? d.width
    height = try c.decodeIfPresent(Int.self, forKey: .height) ?? d.height
    frameRate = try c.decodeIfPresent(Double.self, forKey: .frameRate) ?? d.frameRate
    codec = try c.decodeIfPresent(StreamCodec.self, forKey: .codec) ?? d.codec
    bitrate = try c.decodeIfPresent(Int.self, forKey: .bitrate) ?? d.bitrate
    port = try c.decodeIfPresent(Int.self, forKey: .port) ?? d.port
    path = try c.decodeIfPresent(String.self, forKey: .path) ?? d.path
    audioEnabled = try c.decodeIfPresent(Bool.self, forKey: .audioEnabled) ?? d.audioEnabled
    videoEnabled = try c.decodeIfPresent(Bool.self, forKey: .videoEnabled) ?? d.videoEnabled
    audioSampleRate = try c.decodeIfPresent(Int.self, forKey: .audioSampleRate) ?? d.audioSampleRate
    disabledLensIDs = try c.decodeIfPresent(Set<String>.self, forKey: .disabledLensIDs) ?? d.disabledLensIDs
    cameraPosition = try c.decodeIfPresent(CameraPosition.self, forKey: .cameraPosition) ?? d.cameraPosition
    displayedZoom = try c.decodeIfPresent(Double.self, forKey: .displayedZoom) ?? d.displayedZoom
  }

  public static let `default` = StreamSettings()

  public var dimensionsLabel: String { "\(width)x\(height)" }

  /// Switching codec carries the matching default rate across unless the operator has already
  /// chosen something other than the outgoing codec's default.
  public mutating func setCodec(_ newCodec: StreamCodec) {
    if bitrate == codec.defaultBitrate { bitrate = newCodec.defaultBitrate }
    codec = newCodec
  }

  /// The launch-argument names for each persisted field, which is how an explicit argument is told
  /// apart from a value the operator last chose on the device.
  public enum Field: String, Sendable, CaseIterable {
    case codec
    case bitrateMbps
    case width
    case height
    case frameRate
    case audioEnabled
    case rtspPort
    case rtspPath
    case disabledLenses
  }

  /// What was saved on the device, laid over these launch defaults.
  ///
  /// Anything named in `explicit` is left alone: a flow that pins `-codec h264` has to get H.264
  /// whatever the operator last chose, or a UI test would depend on the state of the handset.
  ///
  /// `videoEnabled` is deliberately not carried across. It is the blanking control, not a
  /// preference, and a camera left blank by a fault injection must come back showing a picture.
  public func merging(saved: StreamSettings, keeping explicit: Set<Field>) -> StreamSettings {
    var merged = self
    if !explicit.contains(.codec) { merged.codec = saved.codec }
    if !explicit.contains(.bitrateMbps) { merged.bitrate = saved.bitrate }
    if !explicit.contains(.width) { merged.width = saved.width }
    if !explicit.contains(.height) { merged.height = saved.height }
    if !explicit.contains(.frameRate) { merged.frameRate = saved.frameRate }
    if !explicit.contains(.audioEnabled) { merged.audioEnabled = saved.audioEnabled }
    if !explicit.contains(.rtspPort) { merged.port = saved.port }
    if !explicit.contains(.rtspPath) { merged.path = saved.path }
    if !explicit.contains(.disabledLenses) { merged.disabledLensIDs = saved.disabledLensIDs }
    return merged
  }
}

/// One capture format, reduced to the facts that decide whether it is usable.
///
/// A plain value type rather than an `AVCaptureDeviceFormat` so the selection rules can be tested
/// without a camera, which matters because the simulator has none.
public struct CaptureFormatDescriptor: Sendable, Equatable, Codable, Hashable {
  public let width: Int
  public let height: Int
  public let minimumFrameRate: Double
  public let maximumFrameRate: Double
  /// False when selecting this format collapses the virtual device to a single lens. On an A15 this
  /// is expected at 4K60, and losing it silently would remove the app's headline feature.
  public let supportsMultiLensSwitching: Bool
  public let isBinned: Bool

  public init(
    width: Int,
    height: Int,
    minimumFrameRate: Double,
    maximumFrameRate: Double,
    supportsMultiLensSwitching: Bool,
    isBinned: Bool = false
  ) {
    self.width = width
    self.height = height
    self.minimumFrameRate = minimumFrameRate
    self.maximumFrameRate = maximumFrameRate
    self.supportsMultiLensSwitching = supportsMultiLensSwitching
    self.isBinned = isBinned
  }

  public var pixelCount: Int { width * height }
  public var label: String { "\(width)x\(height)@\(Int(maximumFrameRate))" }

  public func supports(frameRate: Double) -> Bool {
    frameRate >= minimumFrameRate - 0.01 && frameRate <= maximumFrameRate + 0.01
  }
}
