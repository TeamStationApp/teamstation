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
/// Note what is *not* here: the quality of a camera's own recording. Per-camera archives are a copy
/// of what the camera sent, so their codec, resolution and frame rate are the camera's to choose
/// and there is nothing to configure. The codec and canvas settings below describe the programme
/// master, which is a composite and therefore has to be encoded.
public struct AppConfig: Hashable, Sendable, Codable {
  public var programCodec: ProgramCodec
  public var programResolution: ProgramResolution
  public var programFrameRate: Int
  public var gopSeconds: Double
  public var segmentSeconds: Double
  public var retentionHours: Double
  public var programBitrate: Int
  public var minimumFreeDiskBytes: Int64
  /// Whether the telemetry overlay is drawn over the director grid. A normal setting, not a
  /// test-only flag: the operator turns it on from Settings and it has to still be on tomorrow.
  public var showDebugHUD: Bool
  /// Generated test-pattern cameras instead of live ones. A Settings toggle so switching does not
  /// need a rebuild or a Maestro relaunch; a `-sourceProfile` launch argument still wins for
  /// the session until this is saved again.
  public var useSimulatedCameras: Bool
  /// When false the delay line sizes itself. When true, `displayLatencyCapMilliseconds` is the
  /// most video it may hold.
  public var displayLatencyCapEnabled: Bool
  /// Operator ceiling for monitor latency, in milliseconds. Ignored until the cap is on.
  public var displayLatencyCapMilliseconds: Double
  /// Playback rate for every slow-motion instant-replay button. One setting for the whole board.
  public var replaySlowMotionRate: Double

  public static let displayLatencyCapDefaultMilliseconds: Double = 500
  public static let displayLatencyCapMinimumMilliseconds: Double = 10
  public static let displayLatencyCapMaximumMilliseconds: Double = 2_000
  public static let replaySlowMotionRateDefault: Double = 0.5
  public static let replaySlowMotionRateMinimum: Double = 0
  public static let replaySlowMotionRateMaximum: Double = 1.0

  public init(
    programCodec: ProgramCodec = .hevc,
    programResolution: ProgramResolution = .hd1080,
    programFrameRate: Int = 30,
    gopSeconds: Double = 2,
    segmentSeconds: Double = 3,
    retentionHours: Double = 6,
    programBitrate: Int = 12_000_000,
    minimumFreeDiskBytes: Int64 = 4 * 1024 * 1024 * 1024,
    showDebugHUD: Bool = false,
    useSimulatedCameras: Bool = false,
    displayLatencyCapEnabled: Bool = false,
    displayLatencyCapMilliseconds: Double = AppConfig.displayLatencyCapDefaultMilliseconds,
    replaySlowMotionRate: Double = AppConfig.replaySlowMotionRateDefault
  ) {
    self.programCodec = programCodec
    self.programResolution = programResolution
    self.programFrameRate = programFrameRate
    self.gopSeconds = gopSeconds
    self.segmentSeconds = segmentSeconds
    self.retentionHours = retentionHours
    self.programBitrate = programBitrate
    self.minimumFreeDiskBytes = minimumFreeDiskBytes
    self.showDebugHUD = showDebugHUD
    self.useSimulatedCameras = useSimulatedCameras
    self.displayLatencyCapEnabled = displayLatencyCapEnabled
    self.displayLatencyCapMilliseconds = Self.clampedDisplayLatencyCap(displayLatencyCapMilliseconds)
    self.replaySlowMotionRate = Self.clampedReplaySlowMotionRate(replaySlowMotionRate)
  }

  public static func clampedDisplayLatencyCap(_ milliseconds: Double) -> Double {
    min(
      max(milliseconds, displayLatencyCapMinimumMilliseconds),
      displayLatencyCapMaximumMilliseconds
    )
  }

  public static func clampedReplaySlowMotionRate(_ rate: Double) -> Double {
    min(max(rate, replaySlowMotionRateMinimum), replaySlowMotionRateMaximum)
  }

  /// Written by hand so that a config saved before a key existed still loads.
  ///
  /// The synthesised decoder throws on the first missing key, and `ConfigStore.load` answers a throw
  /// by returning the defaults — so adding one property would silently discard every setting the
  /// operator had chosen.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let fallback = AppConfig()
    self.init(
      programCodec: try container.decodeIfPresent(ProgramCodec.self, forKey: .programCodec)
        ?? fallback.programCodec,
      programResolution: try container.decodeIfPresent(
        ProgramResolution.self,
        forKey: .programResolution
      ) ?? fallback.programResolution,
      programFrameRate: try container.decodeIfPresent(Int.self, forKey: .programFrameRate)
        ?? fallback.programFrameRate,
      gopSeconds: try container.decodeIfPresent(Double.self, forKey: .gopSeconds)
        ?? fallback.gopSeconds,
      segmentSeconds: try container.decodeIfPresent(Double.self, forKey: .segmentSeconds)
        ?? fallback.segmentSeconds,
      retentionHours: try container.decodeIfPresent(Double.self, forKey: .retentionHours)
        ?? fallback.retentionHours,
      programBitrate: try container.decodeIfPresent(Int.self, forKey: .programBitrate)
        ?? fallback.programBitrate,
      minimumFreeDiskBytes: try container.decodeIfPresent(Int64.self, forKey: .minimumFreeDiskBytes)
        ?? fallback.minimumFreeDiskBytes,
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
      replaySlowMotionRate: try container.decodeIfPresent(
        Double.self,
        forKey: .replaySlowMotionRate
      ) ?? fallback.replaySlowMotionRate
    )
  }

  public static let `default` = AppConfig()
}

/// `UserDefaults`-backed store for `AppConfig` and the source selection.
/// `UserDefaults` is thread-safe but not annotated as `Sendable`.
public struct ConfigStore: @unchecked Sendable {
  private let defaults: UserDefaults
  private static let configKey = "co.gamestation.director.config"

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
