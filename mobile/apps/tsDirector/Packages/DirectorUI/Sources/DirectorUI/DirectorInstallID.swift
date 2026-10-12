import Foundation

/// This installation of TS Director, as TeamStation tells its devices apart: a UUID made the first
/// time it is asked for and kept in the app's preferences, so it lasts until the app is deleted.
/// TeamStation keys a device's stream on it, so the same camera name on two iPads is two cameras.
public enum DirectorInstallID {
  public static let key = "teamStationInstallId"

  public static func persisted(in defaults: UserDefaults) -> String {
    if let kept = defaults.string(forKey: key), UUID(uuidString: kept) != nil {
      return kept
    }
    let made = UUID().uuidString.lowercased()
    defaults.set(made, forKey: key)
    return made
  }
}
