import Foundation

/// Where the operator's stream settings are kept between launches.
///
/// Separate from `IdentityStore` because the identity has a different job: it is who this phone is to
/// GS Director, kept in its own file, while settings are ordinary preferences.
public protocol SettingsStore: Sendable {
  func string(forKey key: String) -> String?
  func setString(_ value: String, forKey key: String)
}

/// `@unchecked` because `UserDefaults` is documented as thread-safe but not marked `Sendable`.
public struct UserDefaultsSettingsStore: SettingsStore, @unchecked Sendable {
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func string(forKey key: String) -> String? {
    defaults.string(forKey: key)
  }

  public func setString(_ value: String, forKey key: String) {
    defaults.set(value, forKey: key)
  }
}

public final class InMemorySettingsStore: SettingsStore, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: String]

  public init(values: [String: String] = [:]) {
    self.values = values
  }

  public func string(forKey key: String) -> String? {
    lock.withLock { values[key] }
  }

  public func setString(_ value: String, forKey key: String) {
    lock.withLock { values[key] = value }
  }
}

/// Reads and writes the whole `StreamSettings` as one JSON value.
///
/// One value rather than a key per field so a setting added later cannot be half-saved: whatever is
/// on disk either decodes into a complete set or is ignored.
///
/// `@unchecked` for the same reason as `UserDefaultsSettingsStore`: the legacy handle is a
/// thread-safe `UserDefaults` that is not marked `Sendable`.
public struct StreamSettingsStore: @unchecked Sendable {
  public static let settingsKey = "co.gamestation.cameraman.streamSettings"
  /// The build that persisted lens choices and nothing else used this key. Read when no full set has
  /// been saved yet, so upgrading does not silently switch a disabled lens back on.
  public static let legacyDisabledLensesKey = "co.gamestation.cameraman.disabledLensIDs"

  private let store: SettingsStore
  private let legacyDefaults: UserDefaults?

  public init(
    store: SettingsStore = UserDefaultsSettingsStore(),
    legacyDefaults: UserDefaults? = .standard
  ) {
    self.store = store
    self.legacyDefaults = legacyDefaults
  }

  /// What the operator last chose, or nil when this camera has never been configured.
  public func load() -> StreamSettings? {
    guard let text = store.string(forKey: Self.settingsKey) else { return legacySettings() }
    guard let saved = try? JSONDecoder().decode(StreamSettings.self, from: Data(text.utf8)) else {
      return legacySettings()
    }
    return saved
  }

  public func save(_ settings: StreamSettings) {
    guard let data = try? JSONEncoder().encode(settings),
          let text = String(data: data, encoding: .utf8)
    else { return }
    store.setString(text, forKey: Self.settingsKey)
  }

  /// Lens choices from the older key, expressed as an otherwise-default set. Only the lens field is
  /// then taken from it, so the stale defaults carried here never reach anything.
  private func legacySettings() -> StreamSettings? {
    guard let ids = legacyDefaults?.stringArray(forKey: Self.legacyDisabledLensesKey),
          !ids.isEmpty
    else { return nil }
    var settings = StreamSettings()
    settings.disabledLensIDs = Set(ids)
    return settings
  }
}
