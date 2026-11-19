import Foundation

/// What a UI test may tell a running TS Speedy through `tsspeedy://test/<command>?…`. The app acts
/// on these only when it was launched with the `uiTest` argument.
public enum ControlCommand: Equatable, Sendable {
  /// A reading, exactly as the radar delivers one. Zero is "no reading" for that side.
  case radarFeed(pitch: Int, exit: Int)
  /// A pitch-only reading, then an exit-only reading `gapMs` later, timed inside the app.
  case radarSequence(pitch: Int, exit: Int, gapMs: Int)
  /// Clears the board, the waiting pitch and the speech log.
  case reset

  public static let scheme = "tsspeedy"

  /// The command a link names, or nil for anything else.
  public static func parse(_ url: URL) -> ControlCommand? {
    guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == "test" else { return nil }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let action = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
    var query: [String: Int] = [:]
    for item in components.queryItems ?? [] {
      if let value = item.value.flatMap(Int.init) { query[item.name] = value }
    }
    switch action {
    case "radar-feed":
      return .radarFeed(pitch: max(0, query["pitch"] ?? 0), exit: max(0, query["exit"] ?? 0))
    case "radar-sequence":
      guard let gap = query["gapMs"], gap >= 0 else { return nil }
      return .radarSequence(pitch: max(0, query["pitch"] ?? 0), exit: max(0, query["exit"] ?? 0), gapMs: gap)
    case "reset":
      return .reset
    default:
      return nil
    }
  }
}

/// Whether a launch was for a UI test: `-uiTest true` (as maestro-d and xcodebuild pass launch
/// arguments), `-uiTest 1` or `-uiTest YES`. Anything else, including no value, is a normal launch.
public enum LaunchFlags {
  public static func isUITest(_ arguments: [String]) -> Bool {
    guard let index = arguments.firstIndex(of: "-uiTest"), index + 1 < arguments.count else { return false }
    return [ "true", "1", "yes" ].contains(arguments[index + 1].lowercased())
  }
}
