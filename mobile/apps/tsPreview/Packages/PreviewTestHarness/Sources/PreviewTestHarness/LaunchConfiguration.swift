import Foundation

/// Launch arguments. Unknown keys are recorded so a typo cannot silently pass a test.
public struct LaunchConfiguration: Sendable, Equatable {
  public static let knownKeys = [
    "uiTest",
    "syntheticCameras"
  ]

  public var isUITest = false
  /// Comma-separated advertised names. When non-empty, skip LAN browse and show
  /// synthetic tiles so Maestro and unit tests do not need cameras.
  public var syntheticCameras: [String] = []
  public var unknownKeys: [String] = []

  public init() {}

  public init(arguments: [String], environment: [String: String] = [:]) {
    self.init()

    var values: [String: String] = [:]
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
    if let raw = values["syntheticCameras"], !raw.isEmpty {
      syntheticCameras = raw.split(separator: ",").map {
        $0.trimmingCharacters(in: .whitespacesAndNewlines)
      }.filter { !$0.isEmpty }
    }
  }

  public static func resolve() -> LaunchConfiguration {
    LaunchConfiguration(
      arguments: Array(ProcessInfo.processInfo.arguments.dropFirst()),
      environment: ProcessInfo.processInfo.environment
    )
  }

  private static func bool(_ raw: String?) -> Bool? {
    guard let raw else { return nil }
    switch raw.lowercased() {
    case "1", "true", "yes": return true
    case "0", "false", "no": return false
    default: return nil
    }
  }
}
