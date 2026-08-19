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
    "width",
    "height",
    "frameRate",
    "audioEnabled",
    "cameraName",
    "identityUUID",
    "debugHUD",
    "measureCapabilities"
  ]

  public var isUITest = false
  public var useSyntheticCamera = false
  public var showDebugHUD = false
  /// Runs the capability measurement instead of the camera. It takes about 90 seconds and needs its
  /// own capture session, so it is never on by default.
  public var measureCapabilities = false
  public var settings = StreamSettings.default
  public var cameraName: String?
  /// Pins the identity so a flow can assert an exact CNAME instead of whatever the Keychain holds.
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
    showDebugHUD = Self.bool(values["debugHUD"]) ?? isUITest
    cameraName = values["cameraName"]
    identityUUID = values["identityUUID"]

    if let port = values["rtspPort"].flatMap(Int.init) { settings.port = port }
    if let path = values["rtspPath"] { settings.path = path }
    if let codec = values["codec"].flatMap(StreamCodec.init(rawValue:)) { settings.setCodec(codec) }
    if let mbps = values["bitrateMbps"].flatMap(Double.init) {
      settings.bitrate = Int(mbps * 1_000_000)
    }
    if let width = values["width"].flatMap(Int.init) { settings.width = width }
    if let height = values["height"].flatMap(Int.init) { settings.height = height }
    if let frameRate = values["frameRate"].flatMap(Double.init) { settings.frameRate = frameRate }
    if let audio = Self.bool(values["audioEnabled"]) { settings.audioEnabled = audio }
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
