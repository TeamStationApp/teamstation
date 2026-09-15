import CameramanCore
import Foundation

/// Launch arguments and environment overrides, so a test run can put the app in a known state
/// without tapping through the UI.
///
/// Mirrors GS Producer's harness, including the rule that every key is validated: a typo in a
/// launch argument that is silently ignored produces a green run that proved nothing.
public struct LaunchConfiguration: Sendable, Equatable {
  public static let knownKeys = [
    "uiTest",
    "syntheticCamera",
    "rtspPort",
    "rtspPath",
    "codec",
    "bitrateMbps",
    "bitrateFloorMbps",
    "adaptiveBitrate",
    "width",
    "height",
    "frameRate",
    "audioEnabled",
    "cameraName",
    "identityUUID",
    "debugHUD",
    "persistSettings",
    "measureCapabilities",
    "recordSeconds",
    "selfTest",
    "advertise",
    "disabledLenses",
    "cleanHdmi",
    "encodeWhenIdle"
  ]

  public var isUITest = false
  public var useSyntheticCamera = false
  public var showDebugHUD = false
  /// Runs the capability measurement instead of the camera. It takes about 90 seconds and needs its
  /// own capture session, so it is never on by default.
  public var measureCapabilities = false
  /// Records this many seconds of the encoder's output to an Annex-B file so it can be pulled off the
  /// device and put through ffprobe. Zero means no recording.
  public var recordSeconds: Double = 0
  /// Connects to the app's own listener and reports whether it answers.
  public var selfTest = false
  /// Bonjour advertising, on by default. Off isolates the listener from the advertisement.
  public var advertise = true
  /// Keeps both encoders running with no client playing. Off by default: a phone nobody is
  /// watching over RTSP should not pay for VideoToolbox. On for a soak or a thermal reading that
  /// wants the encode load without a viewer.
  public var encodeWhenIdle = false
  public var settings = StreamSettings.default
  /// Which stream settings this launch named outright. Those must not be replaced by what the
  /// operator last saved on the device, or a flow that pins a format would depend on the handset.
  public var providedSettingFields: Set<StreamSettings.Field> = []
  /// Whether this launch takes part in saved settings, reading them at start-up and writing them on
  /// every change. Off under `uiTest` so a flow neither inherits nor leaves behind a preference —
  /// but settable, because the operator runs with `uiTest` on to get the control server and still
  /// expects the camera to come back the way it was left.
  public var persistSettings = true
  public var cameraName: String?
  /// Pins the identity so a flow can assert an exact CNAME instead of whatever the identity file holds.
  public var identityUUID: String?
  public var unknownKeys: [String] = []

  public init() {}

  public init(arguments: [String], environment: [String: String] = [:]) {
    self.init()

    var values: [String: String] = [:]
    // `-key value` pairs, which is what `xcodebuild` and `devicectl` both pass through cleanly.
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      if argument.hasPrefix("-"), argument.count > 1 {
        let key = String(argument.dropFirst())
        let next = index + 1 < arguments.count ? arguments[index + 1] : nil
        if let next, !next.hasPrefix("-") {
          values[key] = next
          index += 2
          continue
        }
        values[key] = "true"
      }
      index += 1
    }
    for (key, value) in environment where Self.knownKeys.contains(key) {
      values[key] = value
    }

    for key in values.keys where !Self.knownKeys.contains(key) {
      unknownKeys.append(key)
    }
    unknownKeys.sort()

    isUITest = Self.bool(values["uiTest"]) ?? false
    useSyntheticCamera = Self.bool(values["syntheticCamera"]) ?? false
    measureCapabilities = Self.bool(values["measureCapabilities"]) ?? false
    recordSeconds = values["recordSeconds"].flatMap(Double.init) ?? 0
    selfTest = Self.bool(values["selfTest"]) ?? false
    advertise = Self.bool(values["advertise"]) ?? true
    encodeWhenIdle = Self.bool(values["encodeWhenIdle"]) ?? false
    showDebugHUD = Self.bool(values["debugHUD"]) ?? isUITest
    persistSettings = Self.bool(values["persistSettings"]) ?? !isUITest
    cameraName = values["cameraName"]
    identityUUID = values["identityUUID"]

    if let port = values["rtspPort"].flatMap(Int.init) { settings.port = port }
    if let path = values["rtspPath"] { settings.path = path }
    if let codec = values["codec"].flatMap(StreamCodec.init(rawValue:)) { settings.setCodec(codec) }
    if let mbps = values["bitrateMbps"].flatMap(Double.init) {
      settings.setBitrate(Int(mbps * 1_000_000))
    }
    // After the rate, which carries a default floor with it that this then replaces.
    if let mbps = values["bitrateFloorMbps"].flatMap(Double.init) {
      settings.bitrateFloor = Int(mbps * 1_000_000)
    }
    settings.clampFloorToCeiling()
    if let adaptive = Self.bool(values["adaptiveBitrate"]) { settings.adaptiveBitrate = adaptive }
    if let width = values["width"].flatMap(Int.init) { settings.width = width }
    if let height = values["height"].flatMap(Int.init) { settings.height = height }
    if let frameRate = values["frameRate"].flatMap(Double.init) { settings.frameRate = frameRate }
    if let audio = Self.bool(values["audioEnabled"]) { settings.audioEnabled = audio }
    if let clean = Self.bool(values["cleanHdmi"]) { settings.cleanHDMIEnabled = clean }
    if let disabled = values["disabledLenses"] {
      settings.disabledLensIDs = Set(
        disabled.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
      )
    }

    // Recorded after parsing rather than inside each branch: a field counts as provided when the key
    // was present, even if the value failed to parse, because a typo should not hand the decision
    // back to whatever is on disk.
    providedSettingFields = Set(StreamSettings.Field.allCases.filter { values[$0.rawValue] != nil })
  }

  static func bool(_ value: String?) -> Bool? {
    guard let value = value?.lowercased() else { return nil }
    switch value {
    case "1", "true", "yes": return true
    case "0", "false", "no": return false
    default: return nil
    }
  }
}
