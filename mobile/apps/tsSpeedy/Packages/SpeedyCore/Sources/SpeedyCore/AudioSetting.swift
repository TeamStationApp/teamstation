import Foundation

/// Whether TS Speedy speaks. On until the operator turns it off, and remembered across launches.
public struct AudioSetting {
  public static let key = "app.teamstation.speedy.audio"
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public var isOn: Bool {
    get { defaults.object(forKey: Self.key) as? Bool ?? true }
    nonmutating set { defaults.set(newValue, forKey: Self.key) }
  }
}
