import Foundation

/// The test hook: `-TSSplashFreezeAt <seconds>` draws that moment and holds
/// it. Honoured only in a Debug build, a simulator build, or a develop build;
/// a stable build on a device ignores it.
public enum SplashLaunchOptions {
  public static let key = "TSSplashFreezeAt"

  /// The frozen time in milliseconds, or nil. The key's presence is tested
  /// first, so `0` freezes frame 0 rather than reading as absent.
  public static func freezeMs(
    defaults: UserDefaults,
    debug: Bool,
    simulator: Bool,
    develop: Bool
  ) -> Double? {
    guard debug || simulator || develop, let value = defaults.object(forKey: key) else { return nil }
    let seconds: Double?
    switch value {
    case let number as NSNumber: seconds = number.doubleValue
    case let text as String: seconds = Double(text.trimmingCharacters(in: .whitespaces))
    default: seconds = nil
    }
    guard let seconds, seconds.isFinite, seconds >= 0 else { return nil }
    return seconds * 1000
  }

  /// `freezeMs` for this process: its build and the app's develop identity.
  public static func current(develop: Bool, defaults: UserDefaults = .standard) -> Double? {
    #if DEBUG
      let debug = true
    #else
      let debug = false
    #endif
    #if targetEnvironment(simulator)
      let simulator = true
    #else
      let simulator = false
    #endif
    return freezeMs(defaults: defaults, debug: debug, simulator: simulator, develop: develop)
  }
}
