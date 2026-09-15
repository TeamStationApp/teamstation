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
  /// The one port every Cameraman serves on, iPhone and Android alike. Not the registered 554:
  /// Android refuses any port below 1024 to an unprivileged process, and a Director sweep that
  /// probes one Cameraman port has to find both platforms there.
  public static let defaultPort = 8554
  /// What builds before the single port saved. A saved 554 loads as `defaultPort`, so an updated
  /// iPhone moves to the shared port instead of staying where the sweep does not look for it.
  public static let retiredPort = 554

  public var width: Int
  public var height: Int
  public var frameRate: Double
  public var codec: StreamCodec
  /// The operator's rate, and with `adaptiveBitrate` on, the ceiling: the stream runs at this and
  /// comes down, never below `bitrateFloor`, only while the link cannot carry it.
  public var bitrate: Int
  /// The lowest rate adaptation may reach, read only while `adaptiveBitrate` is on and never above
  /// `bitrate`. Half the ceiling unless the operator chose otherwise: an operator who knows the
  /// network can hold the picture higher, or let a weak link go lower before frames drop.
  public var bitrateFloor: Int
  /// Lower the rate while the link to a client backs up, instead of dropping frames at the full
  /// rate. On by default; a softer picture for a few seconds beats a frozen one.
  public var adaptiveBitrate: Bool
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
  /// Whether a connected external display shows the encoder's picture with no overlays. Off hands
  /// the display back to iOS mirroring, which shows this screen, chrome and all. Not a pipeline
  /// setting: toggling it must never restart the encoder or cut the stream.
  public var cleanHDMIEnabled: Bool

  public init(
    width: Int = 1920,
    height: Int = 1080,
    frameRate: Double = 30,
    codec: StreamCodec = .hevc,
    bitrate: Int = StreamCodec.hevc.defaultBitrate,
    /// The default floor for `bitrate` when nil.
    bitrateFloor: Int? = nil,
    adaptiveBitrate: Bool = true,
    port: Int = StreamSettings.defaultPort,
    path: String = StreamSettings.canonicalPath,
    audioEnabled: Bool = true,
    videoEnabled: Bool = true,
    audioSampleRate: Int = 48_000,
    disabledLensIDs: Set<String> = [],
    cameraPosition: CameraPosition = .back,
    displayedZoom: Double = 1,
    cleanHDMIEnabled: Bool = true
  ) {
    self.width = width
    self.height = height
    self.frameRate = frameRate
    self.codec = codec
    self.bitrate = bitrate
    self.bitrateFloor = min(bitrateFloor ?? Self.defaultBitrateFloor(forCeiling: bitrate), bitrate)
    self.adaptiveBitrate = adaptiveBitrate
    self.port = port
    self.path = path
    self.audioEnabled = audioEnabled
    self.videoEnabled = videoEnabled
    self.audioSampleRate = audioSampleRate
    self.cameraPosition = cameraPosition
    self.displayedZoom = displayedZoom
    self.disabledLensIDs = disabledLensIDs
    self.cleanHDMIEnabled = cleanHDMIEnabled
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
    // Saved before the floor was a setting, when it was always half the ceiling.
    bitrateFloor = min(
      try c.decodeIfPresent(Int.self, forKey: .bitrateFloor) ?? Self.defaultBitrateFloor(forCeiling: bitrate),
      bitrate
    )
    adaptiveBitrate = try c.decodeIfPresent(Bool.self, forKey: .adaptiveBitrate) ?? d.adaptiveBitrate
    let savedPort = try c.decodeIfPresent(Int.self, forKey: .port) ?? d.port
    port = savedPort == Self.retiredPort ? Self.defaultPort : savedPort
    path = try c.decodeIfPresent(String.self, forKey: .path) ?? d.path
    audioEnabled = try c.decodeIfPresent(Bool.self, forKey: .audioEnabled) ?? d.audioEnabled
    videoEnabled = try c.decodeIfPresent(Bool.self, forKey: .videoEnabled) ?? d.videoEnabled
    audioSampleRate = try c.decodeIfPresent(Int.self, forKey: .audioSampleRate) ?? d.audioSampleRate
    disabledLensIDs = try c.decodeIfPresent(Set<String>.self, forKey: .disabledLensIDs) ?? d.disabledLensIDs
    cameraPosition = try c.decodeIfPresent(CameraPosition.self, forKey: .cameraPosition) ?? d.cameraPosition
    displayedZoom = try c.decodeIfPresent(Double.self, forKey: .displayedZoom) ?? d.displayedZoom
    cleanHDMIEnabled = try c.decodeIfPresent(Bool.self, forKey: .cleanHDMIEnabled) ?? d.cleanHDMIEnabled
  }

  public static let `default` = StreamSettings()

  public var dimensionsLabel: String { "\(width)x\(height)" }

  /// The lowest rate either end of the bitrate range may be set to, in the Settings sliders and
  /// over the wire.
  public static let minimumBitrate = 1_000_000

  /// Half the ceiling, which is where the floor always sat before it was a setting, but not below
  /// `minimumBitrate`, and never above the ceiling itself.
  public static func defaultBitrateFloor(forCeiling ceiling: Int) -> Int {
    min(ceiling, max(minimumBitrate, ceiling / 2))
  }

  /// Switching codec carries the matching default rate across unless the operator has already
  /// chosen something other than the outgoing codec's default, and the default floor with it.
  public mutating func setCodec(_ newCodec: StreamCodec) {
    if bitrate == codec.defaultBitrate { setBitrate(newCodec.defaultBitrate) }
    codec = newCodec
  }

  /// A new rate. A floor still at the old rate's default moves to the new rate's, so an operator who
  /// never chose a floor keeps getting half of whatever they pick; a floor they did choose stays, and
  /// comes down only when the rate now sits below it.
  public mutating func setBitrate(_ newBitrate: Int) {
    if bitrateFloor == Self.defaultBitrateFloor(forCeiling: bitrate) {
      bitrateFloor = Self.defaultBitrateFloor(forCeiling: newBitrate)
    }
    bitrate = newBitrate
    clampFloorToCeiling()
  }

  /// Brings the floor down to the rate when it has been left above it: a floor over the ceiling
  /// means nothing to the controller, and on screen it would read as a range turned inside out.
  public mutating func clampFloorToCeiling() {
    bitrateFloor = min(bitrateFloor, bitrate)
  }

  /// The launch-argument names for each persisted field, which is how an explicit argument is told
  /// apart from a value the operator last chose on the device.
  public enum Field: String, Sendable, CaseIterable {
    case codec
    case bitrateMbps
    case bitrateFloorMbps
    case adaptiveBitrate
    case width
    case height
    case frameRate
    case audioEnabled
    case rtspPort
    case rtspPath
    case disabledLenses
    case cleanHDMI = "cleanHdmi"
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
    // A floor was chosen against its own ceiling. A launch that pins the rate and not the floor
    // gets the floor that goes with the pinned rate, not one saved against a different rate.
    if !explicit.contains(.bitrateFloorMbps), !explicit.contains(.bitrateMbps) {
      merged.bitrateFloor = saved.bitrateFloor
    }
    merged.clampFloorToCeiling()
    if !explicit.contains(.adaptiveBitrate) { merged.adaptiveBitrate = saved.adaptiveBitrate }
    if !explicit.contains(.width) { merged.width = saved.width }
    if !explicit.contains(.height) { merged.height = saved.height }
    if !explicit.contains(.frameRate) { merged.frameRate = saved.frameRate }
    if !explicit.contains(.audioEnabled) { merged.audioEnabled = saved.audioEnabled }
    if !explicit.contains(.rtspPort) { merged.port = saved.port }
    if !explicit.contains(.rtspPath) { merged.path = saved.path }
    if !explicit.contains(.disabledLenses) { merged.disabledLensIDs = saved.disabledLensIDs }
    if !explicit.contains(.cleanHDMI) { merged.cleanHDMIEnabled = saved.cleanHDMIEnabled }
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
