import Foundation

public enum ProgramCodec: String, Sendable, Codable, CaseIterable {
  case h264
  case hevc

  public var displayName: String {
    switch self {
    case .h264: "H.264"
    case .hevc: "HEVC"
    }
  }
}

public struct ProgramResolution: Hashable, Sendable, Codable {
  public var width: Int
  public var height: Int

  public init(width: Int, height: Int) {
    self.width = width
    self.height = height
  }

  public static let hd1080 = ProgramResolution(width: 1920, height: 1080)
  public static let hd720 = ProgramResolution(width: 1280, height: 720)

  public var displayName: String { "\(height)p" }
}

/// Everything the operator can change, persisted in `UserDefaults` and readable from any
/// thread as an immutable value.
///
/// Three groups of encoding settings, each independent of the others:
///
/// - **Raw camera encoding** (`rawCamera…`): an NDI camera's archive, which the app has to encode
///   because the free SDK decodes before a receiver sees a frame, and every exported camera file. An
///   RTSP camera's archive is a copy of what it sent and is never re-encoded; only its export is.
/// - **Programme master recording** (`program…`): the master, which is a composite and has to be
///   encoded whatever the cameras are, and a programme export that has to be re-encoded.
/// - **Programme master stream** (`stream…`): the live RTMP stream, which has its own encoder.
/// Where the Stream button sends the programme.
public enum StreamDestination: String, Codable, Sendable, CaseIterable {
  /// The RTMP URL the operator typed. What every Director did before events existed.
  case url
  /// A game picked from TeamStation, whose stream URL the app holds and never shows.
  case event
}

public struct AppConfig: Hashable, Sendable, Codable {
  public var programCodec: ProgramCodec
  /// Codec for an NDI camera's archive and every exported camera file.
  ///
  /// HEVC by default because the encode budget decides how many cameras can be recorded at once:
  /// the same hardware sustains 118 fps of 1080p H.264 and 296 fps of 1080p HEVC, which at 60 fps
  /// per camera is the difference between two cameras and four. H.264 is offered for a player that
  /// cannot open HEVC.
  public var rawCameraCodec: ProgramCodec
  public var programResolution: ProgramResolution
  public var programFrameRate: Int
  /// Keyframe spacing, shared by all three groups.
  public var gopSeconds: Double
  public var segmentSeconds: Double
  /// Ceiling on the archive. Once the segments on disk exceed this, the oldest recordings are
  /// dropped whole until they fit again. Sized in bytes rather than hours because an hour of
  /// archive is worth wildly different amounts of disk depending on camera count and bitrate,
  /// and a six-hour window silently discarded a 109-minute game the morning after it was shot.
  public var maximumArchiveBytes: Int64
  public var programBitrate: Int
  /// Hard headroom for the *writer*: archiving stops rather than filling the device.
  public var minimumFreeDiskBytes: Int64
  /// Free space the *sweeper* keeps available. When the volume falls below this, the oldest
  /// recordings are dropped until it is clear again, even if the archive is under its ceiling.
  public var freeDiskFloorBytes: Int64
  /// Size an NDI camera is archived at and every camera is exported at. A camera sending something
  /// else is scaled to fit, its shape kept.
  public var rawCameraResolution: ProgramResolution
  /// The one frame rate an NDI archive is encoded at and every camera is exported at, whatever the
  /// camera sent: pictures a camera did not send are repeated, extra ones are dropped.
  public var rawCameraFrameRate: Int
  public var rawCameraBitrate: Int
  /// The stream's codec. HEVC needs a service that takes Enhanced RTMP.
  public var streamCodec: ProgramCodec
  public var streamResolution: ProgramResolution
  public var streamFrameRate: Int
  /// The stream starts at `streamBitrateHigh` and comes down towards `streamBitrateLow` while the
  /// network cannot keep up, rather than drop frames.
  public var streamBitrateLow: Int
  public var streamBitrateHigh: Int
  /// Whether the telemetry overlay is drawn over the director grid. A normal setting, not a
  /// test-only flag: the operator turns it on from Settings and it has to still be on tomorrow.
  public var showDebugHUD: Bool
  /// Generated test-pattern cameras instead of live ones. A Settings toggle so switching does not
  /// need a rebuild or a Maestro relaunch; a `-sourceProfile` launch argument still wins for
  /// the session until this is saved again.
  public var useSimulatedCameras: Bool
  /// When false the delay line sizes itself. When true, `displayLatencyCapMilliseconds` is the
  /// most video it may hold.
  /// Off by default, after turning it on made things worse rather than better.
  ///
  /// The cap refuses a picture that is too old and holds the last good one instead. That is only an
  /// improvement while *some* frames pass: when every frame is refused, the held picture is what
  /// ages, and the tile ends up showing older content than it would have with no cap at all.
  /// Measured on the bench with a 500 ms cap — a Pixel tile sixteen seconds behind the wall clock
  /// with 633 refusals, while its own capture-time correction was out by 1.309 s. A cap below the
  /// error in the capture-time estimate refuses everything, and refusing everything is indefinite
  /// staleness rather than a monitor that holds briefly.
  ///
  /// Turning it on needs the clock offset to be trustworthy first, and a cap chosen above the
  /// residual error rather than below it. Until then this stays where it was.
  ///
  /// Its counterpart, `diskLatencyCapEnabled`, stays off on purpose: the recording is watched
  /// afterwards, where a late picture is simply a picture, and dropping it leaves a hole in the
  /// tape. The monitor refuses, the archive keeps everything, which is the whole reason there are
  /// two of them.
  public var displayLatencyCapEnabled: Bool
  /// Operator ceiling for monitor latency, in milliseconds. Ignored until the cap is on.
  public var displayLatencyCapMilliseconds: Double
  /// Whether a picture too old to show is also too old to keep.
  ///
  /// Separate from the display cap because the two answer different questions. The monitor is
  /// worthless showing action that has already happened, so a late picture is better skipped; the
  /// recording is watched afterwards, where a late picture is simply a picture and dropping it
  /// leaves a hole in the tape. The disk cap is therefore the more generous of the two, and exists
  /// only to stop a source that has fallen minutes behind from writing history into the middle of
  /// a recording.
  public var diskLatencyCapEnabled: Bool
  /// Operator ceiling for how old a picture may be and still be archived, in milliseconds.
  public var diskLatencyCapMilliseconds: Double
  /// Playback rate for every slow-motion instant-replay button. One setting for the whole board.
  public var replaySlowMotionRate: Double
  /// RTMP publish URL for the programme output. Empty means streaming is off until the operator
  /// enters one. Not a launch-only flag: it has to still be there tomorrow.
  public var streamURL: String
  /// Which of the two destinations the Stream button publishes to.
  ///
  /// Defaults to the typed URL, so every Director that already has one keeps behaving exactly as
  /// it did. Choosing a TeamStation event is the other way, and the app never shows that URL: the
  /// event *is* the destination, and its key lives in the keychain with the account.
  public var streamDestination: StreamDestination
  /// The name this Director's camera is given when it claims a TeamStation event.
  ///
  /// Empty means the claim does not name a camera. A config saved before the key
  /// existed decodes as empty, so an iPad already in use keeps every other setting.
  public var cameraName: String
  /// Sweep a different /24 for cameras instead of this iPad's own, for a bench where the cameras sit
  /// behind a traffic shaper on another subnet. Off for normal use.
  public var subnetScanOverrideEnabled: Bool
  /// The subnets to sweep while the override is on, as the operator typed them: one, or two
  /// separated by a comma (`192.168.6.0, 192.168.7.0`). Kept when the override is off, so turning it
  /// back on does not mean typing them again. Always full /24s.
  public var subnetScanOverride: String
  /// How long the app may have been away and still pick a take back up.
  public var resumeDowntimeLimitSeconds: Double

  public static let displayLatencyCapDefaultMilliseconds: Double = 500
  public static let displayLatencyCapMinimumMilliseconds: Double = 10
  public static let displayLatencyCapMaximumMilliseconds: Double = 2_000
  /// Ten seconds by default: far beyond any delivery hiccup worth keeping, and short enough that a
  /// source which has fallen badly behind stops writing stale pictures into the recording.
  public static let diskLatencyCapDefaultMilliseconds: Double = 10_000
  public static let diskLatencyCapMinimumMilliseconds: Double = 100
  public static let diskLatencyCapMaximumMilliseconds: Double = 60_000
  public static let replaySlowMotionRateDefault: Double = 0.5
  public static let replaySlowMotionRateMinimum: Double = 0
  public static let replaySlowMotionRateMaximum: Double = 1.0

  /// The stream's bitrate range: 1 to 10 Mbps in half-megabit steps. Ten is the most the stream may
  /// ever send.
  public static let streamBitrateMinimum = 1_000_000
  public static let streamBitrateMaximum = 10_000_000
  public static let streamBitrateStep = 500_000
  public static let rawCameraBitrateMinimum = 1_000_000
  public static let rawCameraBitrateMaximum = 40_000_000
  /// The frame rates offered for the raw camera and stream encodings.
  public static let frameRateChoices = [ 24, 25, 30, 50, 60 ]

  /// How long the app may have been gone and still pick a take back up, in seconds.
  ///
  /// An hour. Long enough to cover a crash, a reboot, a flat battery put on charge, or the walk
  /// back to the bench; short enough that yesterday's abandoned take does not come back to life
  /// tomorrow and run until somebody notices. The clock is on the app being away, not on the
  /// take's own length: a two-hour game interrupted for ninety seconds resumes.
  public static let resumeDowntimeLimitDefaultSeconds: Double = 3_600
  public static let resumeDowntimeLimitMinimumSeconds: Double = 60
  public static let resumeDowntimeLimitMaximumSeconds: Double = 86_400

  /// The defaults are a new install's. A saved config keeps every value it has; see `init(from:)`.
  public init(
    programCodec: ProgramCodec = .hevc,
    rawCameraCodec: ProgramCodec = .hevc,
    programResolution: ProgramResolution = .hd1080,
    programFrameRate: Int = 30,
    gopSeconds: Double = 2,
    segmentSeconds: Double = 3,
    maximumArchiveBytes: Int64 = AppConfig.maximumArchiveBytesDefault,
    programBitrate: Int = 4_000_000,
    minimumFreeDiskBytes: Int64 = 4 * 1024 * 1024 * 1024,
    freeDiskFloorBytes: Int64 = AppConfig.freeDiskFloorBytesDefault,
    rawCameraResolution: ProgramResolution = .hd1080,
    rawCameraFrameRate: Int = 60,
    rawCameraBitrate: Int = 6_000_000,
    streamCodec: ProgramCodec = .hevc,
    streamResolution: ProgramResolution = .hd1080,
    streamFrameRate: Int = 60,
    streamBitrateLow: Int = 2_000_000,
    streamBitrateHigh: Int = 6_000_000,
    showDebugHUD: Bool = false,
    useSimulatedCameras: Bool = false,
    displayLatencyCapEnabled: Bool = false,
    displayLatencyCapMilliseconds: Double = AppConfig.displayLatencyCapDefaultMilliseconds,
    diskLatencyCapEnabled: Bool = false,
    diskLatencyCapMilliseconds: Double = AppConfig.diskLatencyCapDefaultMilliseconds,
    replaySlowMotionRate: Double = AppConfig.replaySlowMotionRateDefault,
    streamURL: String = "",
    streamDestination: StreamDestination = .url,
    cameraName: String = "",
    subnetScanOverrideEnabled: Bool = false,
    subnetScanOverride: String = "",
    resumeDowntimeLimitSeconds: Double = AppConfig.resumeDowntimeLimitDefaultSeconds
  ) {
    self.programCodec = programCodec
    self.rawCameraCodec = rawCameraCodec
    self.programResolution = programResolution
    self.programFrameRate = programFrameRate
    self.gopSeconds = gopSeconds
    self.segmentSeconds = segmentSeconds
    self.maximumArchiveBytes = max(0, maximumArchiveBytes)
    self.programBitrate = programBitrate
    self.minimumFreeDiskBytes = minimumFreeDiskBytes
    self.freeDiskFloorBytes = max(0, freeDiskFloorBytes)
    self.rawCameraResolution = rawCameraResolution
    self.rawCameraFrameRate = max(1, rawCameraFrameRate)
    self.rawCameraBitrate = Self.clampedRawCameraBitrate(rawCameraBitrate)
    self.streamCodec = streamCodec
    self.streamResolution = streamResolution
    self.streamFrameRate = max(1, streamFrameRate)
    let stream = Self.clampedStreamBitrates(low: streamBitrateLow, high: streamBitrateHigh)
    self.streamBitrateLow = stream.low
    self.streamBitrateHigh = stream.high
    self.showDebugHUD = showDebugHUD
    self.useSimulatedCameras = useSimulatedCameras
    self.displayLatencyCapEnabled = displayLatencyCapEnabled
    self.displayLatencyCapMilliseconds = Self.clampedDisplayLatencyCap(displayLatencyCapMilliseconds)
    self.diskLatencyCapEnabled = diskLatencyCapEnabled
    self.diskLatencyCapMilliseconds = Self.clampedDiskLatencyCap(diskLatencyCapMilliseconds)
    self.replaySlowMotionRate = Self.clampedReplaySlowMotionRate(replaySlowMotionRate)
    self.streamURL = streamURL
    self.streamDestination = streamDestination
    self.cameraName = cameraName
    self.subnetScanOverrideEnabled = subnetScanOverrideEnabled
    self.subnetScanOverride = subnetScanOverride
    self.resumeDowntimeLimitSeconds = Self.clampedResumeDowntimeLimit(resumeDowntimeLimitSeconds)
  }

  // MARK: - The encoding groups as values

  /// NDI archives and every exported camera file.
  public var rawCameraEncoding: EncodeSettings {
    EncodeSettings(
      codec: rawCameraCodec,
      resolution: rawCameraResolution,
      frameRate: rawCameraFrameRate,
      bitrate: rawCameraBitrate,
      keyframeSeconds: gopSeconds
    )
  }

  /// The programme master recording.
  public var programEncoding: EncodeSettings {
    EncodeSettings(
      codec: programCodec,
      resolution: programResolution,
      frameRate: programFrameRate,
      bitrate: programBitrate,
      keyframeSeconds: gopSeconds
    )
  }

  /// The programme master stream, at the top of its range; `streamBitrateLow` is the floor.
  public var streamEncoding: EncodeSettings {
    EncodeSettings(
      codec: streamCodec,
      resolution: streamResolution,
      frameRate: streamFrameRate,
      bitrate: streamBitrateHigh,
      keyframeSeconds: gopSeconds
    )
  }

  /// What a take starting now is recorded with, kept with the take for its exports.
  public var takeEncoding: TakeEncoding {
    TakeEncoding(rawCamera: rawCameraEncoding, programme: programEncoding)
  }

  // MARK: - Clamping

  public static func clampedResumeDowntimeLimit(_ seconds: Double) -> Double {
    min(max(seconds, resumeDowntimeLimitMinimumSeconds), resumeDowntimeLimitMaximumSeconds)
  }

  public static func clampedRawCameraBitrate(_ bitrate: Int) -> Int {
    min(max(bitrate, rawCameraBitrateMinimum), rawCameraBitrateMaximum)
  }

  /// Both stream bitrates on the half-megabit grid, inside 1–10 Mbps, and the low one never above
  /// the high one. They may meet, which is a fixed bitrate.
  public static func clampedStreamBitrates(low: Int, high: Int) -> (low: Int, high: Int) {
    func clamp(_ bitrate: Int) -> Int {
      let snapped = Int((Double(bitrate) / Double(streamBitrateStep)).rounded()) * streamBitrateStep
      return min(max(snapped, streamBitrateMinimum), streamBitrateMaximum)
    }
    let high = clamp(high)
    return (min(clamp(low), high), high)
  }

  /// The /24s to sweep instead of the local one, as network addresses (`192.168.6.0`). Empty when the
  /// override is off or what was typed is not one or two subnets.
  public var activeScanSubnets: [String] {
    guard subnetScanOverrideEnabled else { return [] }
    return Self.scanSubnetNetworkAddresses(subnetScanOverride) ?? []
  }

  /// How many subnets the override may name: the shaped cameras' and one more, such as the NDI box's.
  public static let maximumScanSubnets = 2

  /// `["192.168.6.0", "192.168.7.0"]` from `192.168.6.0, 192.168.7.0`; a repeat counts once. Nil when any part
  /// is not a dotted quad, or more than `maximumScanSubnets` are named.
  public static func scanSubnetNetworkAddresses(_ text: String) -> [String]? {
    let parts = text.split(separator: ",").map(String.init)
    guard !parts.isEmpty, parts.count <= maximumScanSubnets else { return nil }
    var addresses: [String] = []
    for part in parts {
      guard let address = scanSubnetNetworkAddress(part) else { return nil }
      if !addresses.contains(address) { addresses.append(address) }
    }
    return addresses
  }

  /// `192.168.6.0` from `192.168.6.0`, `192.168.6.25` or ` 192.168.6.0/24 `: the first three octets, since
  /// only a full /24 is supported. Nil for anything that is not a dotted quad.
  public static func scanSubnetNetworkAddress(_ text: String) -> String? {
    var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasSuffix("/24") { trimmed = String(trimmed.dropLast(3)) }
    let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    let octets = parts.compactMap { UInt8($0) }
    guard octets.count == 4 else { return nil }
    return "\(octets[0]).\(octets[1]).\(octets[2]).0"
  }

  public static func clampedDisplayLatencyCap(_ milliseconds: Double) -> Double {
    min(
      max(milliseconds, displayLatencyCapMinimumMilliseconds),
      displayLatencyCapMaximumMilliseconds
    )
  }

  public static func clampedDiskLatencyCap(_ milliseconds: Double) -> Double {
    min(
      max(milliseconds, diskLatencyCapMinimumMilliseconds),
      diskLatencyCapMaximumMilliseconds
    )
  }

  public static func clampedReplaySlowMotionRate(_ rate: Double) -> Double {
    min(max(rate, replaySlowMotionRateMinimum), replaySlowMotionRateMaximum)
  }

  // MARK: - Decoding

  /// Keys a config was saved under before they were renamed.
  private enum LegacyKeys: String, CodingKey {
    /// The NDI archive codec, now `rawCameraCodec`.
    case sourceEncodeCodec
  }

  /// Written by hand so that a config saved before a key existed still loads.
  ///
  /// The synthesised decoder throws on the first missing key, and `ConfigStore.load` answers a throw
  /// by returning the defaults — so adding one property would silently discard every setting the
  /// operator had chosen.
  ///
  /// A saved config is an iPad already in use, so a group it has never saved carries on doing what
  /// it did, rather than taking a new install's defaults: the stream was the programme's settings in
  /// H.264, capped here at the stream's 10 Mbps, with half that as its floor; an NDI archive was
  /// encoded at the programme's bitrate.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let legacy = try decoder.container(keyedBy: LegacyKeys.self)
    let fallback = AppConfig()
    let programResolution = try container.decodeIfPresent(
      ProgramResolution.self,
      forKey: .programResolution
    ) ?? fallback.programResolution
    let programFrameRate = try container.decodeIfPresent(Int.self, forKey: .programFrameRate)
      ?? fallback.programFrameRate
    let programBitrate = try container.decodeIfPresent(Int.self, forKey: .programBitrate)
      ?? fallback.programBitrate
    self.init(
      programCodec: try container.decodeIfPresent(ProgramCodec.self, forKey: .programCodec)
        ?? fallback.programCodec,
      rawCameraCodec: try container.decodeIfPresent(ProgramCodec.self, forKey: .rawCameraCodec)
        ?? legacy.decodeIfPresent(ProgramCodec.self, forKey: .sourceEncodeCodec)
        ?? fallback.rawCameraCodec,
      programResolution: programResolution,
      programFrameRate: programFrameRate,
      gopSeconds: try container.decodeIfPresent(Double.self, forKey: .gopSeconds)
        ?? fallback.gopSeconds,
      segmentSeconds: try container.decodeIfPresent(Double.self, forKey: .segmentSeconds)
        ?? fallback.segmentSeconds,
      maximumArchiveBytes: try container.decodeIfPresent(Int64.self, forKey: .maximumArchiveBytes)
        ?? fallback.maximumArchiveBytes,
      programBitrate: programBitrate,
      minimumFreeDiskBytes: try container.decodeIfPresent(Int64.self, forKey: .minimumFreeDiskBytes)
        ?? fallback.minimumFreeDiskBytes,
      freeDiskFloorBytes: try container.decodeIfPresent(Int64.self, forKey: .freeDiskFloorBytes)
        ?? fallback.freeDiskFloorBytes,
      rawCameraResolution: try container.decodeIfPresent(
        ProgramResolution.self,
        forKey: .rawCameraResolution
      ) ?? fallback.rawCameraResolution,
      rawCameraFrameRate: try container.decodeIfPresent(Int.self, forKey: .rawCameraFrameRate)
        ?? fallback.rawCameraFrameRate,
      rawCameraBitrate: try container.decodeIfPresent(Int.self, forKey: .rawCameraBitrate)
        ?? programBitrate,
      streamCodec: try container.decodeIfPresent(ProgramCodec.self, forKey: .streamCodec)
        ?? .h264,
      streamResolution: try container.decodeIfPresent(
        ProgramResolution.self,
        forKey: .streamResolution
      ) ?? programResolution,
      streamFrameRate: try container.decodeIfPresent(Int.self, forKey: .streamFrameRate)
        ?? programFrameRate,
      streamBitrateLow: try container.decodeIfPresent(Int.self, forKey: .streamBitrateLow)
        ?? min(programBitrate, Self.streamBitrateMaximum) / 2,
      streamBitrateHigh: try container.decodeIfPresent(Int.self, forKey: .streamBitrateHigh)
        ?? programBitrate,
      showDebugHUD: try container.decodeIfPresent(Bool.self, forKey: .showDebugHUD)
        ?? fallback.showDebugHUD,
      useSimulatedCameras: try container.decodeIfPresent(Bool.self, forKey: .useSimulatedCameras)
        ?? fallback.useSimulatedCameras,
      displayLatencyCapEnabled: try container.decodeIfPresent(
        Bool.self,
        forKey: .displayLatencyCapEnabled
      ) ?? fallback.displayLatencyCapEnabled,
      displayLatencyCapMilliseconds: try container.decodeIfPresent(
        Double.self,
        forKey: .displayLatencyCapMilliseconds
      ) ?? fallback.displayLatencyCapMilliseconds,
      diskLatencyCapEnabled: try container.decodeIfPresent(
        Bool.self,
        forKey: .diskLatencyCapEnabled
      ) ?? fallback.diskLatencyCapEnabled,
      diskLatencyCapMilliseconds: try container.decodeIfPresent(
        Double.self,
        forKey: .diskLatencyCapMilliseconds
      ) ?? fallback.diskLatencyCapMilliseconds,
      replaySlowMotionRate: try container.decodeIfPresent(
        Double.self,
        forKey: .replaySlowMotionRate
      ) ?? fallback.replaySlowMotionRate,
      streamURL: try container.decodeIfPresent(String.self, forKey: .streamURL)
        ?? fallback.streamURL,
      // `try?`, unlike every other field here, because this one is an enum: a
      // value that is not one of its cases throws rather than returning nil,
      // and one unreadable key must not cost somebody every other setting in
      // the file.
      streamDestination: (try? container.decodeIfPresent(
        StreamDestination.self,
        forKey: .streamDestination
      )) as? StreamDestination ?? fallback.streamDestination,
      cameraName: try container.decodeIfPresent(String.self, forKey: .cameraName)
        ?? fallback.cameraName,
      subnetScanOverrideEnabled: try container.decodeIfPresent(
        Bool.self,
        forKey: .subnetScanOverrideEnabled
      ) ?? fallback.subnetScanOverrideEnabled,
      subnetScanOverride: try container.decodeIfPresent(String.self, forKey: .subnetScanOverride)
        ?? fallback.subnetScanOverride,
      resumeDowntimeLimitSeconds: try container.decodeIfPresent(
        Double.self,
        forKey: .resumeDowntimeLimitSeconds
      ) ?? fallback.resumeDowntimeLimitSeconds
    )
  }

  public static let gigabyte: Int64 = 1024 * 1024 * 1024
  /// 250 GB of archive on a 1 TB iPad: several full games, and still most of the device free.
  public static let maximumArchiveBytesDefault: Int64 = 250 * AppConfig.gigabyte
  /// Sweeping starts if free space falls under 100 GB, whatever the archive size.
  public static let freeDiskFloorBytesDefault: Int64 = 100 * AppConfig.gigabyte

  public static let `default` = AppConfig()
}

/// `UserDefaults`-backed store for `AppConfig` and the source selection.
/// `UserDefaults` is thread-safe but not annotated as `Sendable`.
public struct ConfigStore: @unchecked Sendable {
  private let defaults: UserDefaults
  private static let configKey = "app.teamstation.director.config"

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func load() -> AppConfig {
    guard
      let data = defaults.data(forKey: Self.configKey),
      let decoded = try? JSONDecoder().decode(AppConfig.self, from: data)
    else { return .default }
    return decoded
  }

  public func save(_ config: AppConfig) {
    guard let data = try? JSONEncoder().encode(config) else { return }
    defaults.set(data, forKey: Self.configKey)
  }

  public func codableValue<T: Codable>(_ type: T.Type, forKey key: String) -> T? {
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  public func setCodableValue(_ value: some Codable, forKey key: String) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    defaults.set(data, forKey: key)
  }

  public func removeValue(forKey key: String) {
    defaults.removeObject(forKey: key)
  }
}
