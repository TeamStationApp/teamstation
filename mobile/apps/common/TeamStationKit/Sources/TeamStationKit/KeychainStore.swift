import Foundation
import Security

/// Where the device token and the chosen game are kept.
///
/// The keychain, not `UserDefaults` and not `AppConfig`: a token good for a
/// season is a credential, and the settings file is copied off the iPad by the
/// export tools and read by anyone debugging a take.
///
/// The chosen event goes here too, because it carries the stream key inside its
/// URL. It is the same secret wearing a different coat, and splitting them
/// across two stores would only mean two places to leak from.
public struct KeychainStore: Sendable {
  private let service: String
  private let memory: Memory?
  private static let tokenKey = "teamStationToken"
  private static let eventKey = "teamStationChosenEvent"
  private static let scopeKey = "teamStationAccountScope"

  public init(service: String) {
    self.service = service
    memory = nil
  }

  /// A store that never touches the keychain, for tests: each one starts
  /// empty and forgets everything when it goes.
  public static func inMemory() -> KeychainStore {
    KeychainStore(memory: Memory())
  }

  private init(memory: Memory) {
    service = "inMemory"
    self.memory = memory
  }

  private final class Memory: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    subscript(key: String) -> Data? {
      get { lock.withLock { items[key] } }
      set { lock.withLock { items[key] = newValue } }
    }
  }

  public func token() -> String? {
    guard let data = read(Self.tokenKey) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func setToken(_ token: String?) {
    write(Self.tokenKey, data: token?.data(using: .utf8))
  }

  public func chosenEvent() -> TeamStationAccount.ChosenEvent? {
    guard let data = read(Self.eventKey) else { return nil }
    return try? TeamStationClient.decoder.decode(
      TeamStationAccount.ChosenEvent.self,
      from: data
    )
  }

  public func setChosenEvent(_ event: TeamStationAccount.ChosenEvent?) {
    guard let event else {
      write(Self.eventKey, data: nil)
      return
    }
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    write(Self.eventKey, data: try? encoder.encode(event))
  }

  /// The account and server the token was last validated against; nil when none was kept
  /// (including every keychain written before this was).
  public func accountScope() -> TeamStationAccountScope? {
    guard let data = read(Self.scopeKey) else { return nil }
    return try? JSONDecoder().decode(TeamStationAccountScope.self, from: data)
  }

  public func setAccountScope(_ scope: TeamStationAccountScope?) {
    write(Self.scopeKey, data: scope.flatMap { try? JSONEncoder().encode($0) })
  }

  // MARK: - The keychain itself

  private func query(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key
    ]
  }

  private func read(_ key: String) -> Data? {
    if let memory { return memory[key] }
    var request = query(key)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess
    else { return nil }
    return item as? Data
  }

  private func write(_ key: String, data: Data?) {
    if let memory {
      memory[key] = data
      return
    }
    SecItemDelete(query(key) as CFDictionary)
    guard let data else { return }
    var request = query(key)
    request[kSecValueData as String] = data
    // The iPad lives in a bag and is unlocked before a game. `AfterFirstUnlock`
    // so a Director relaunched by the watchdog mid-game can still read its own
    // token without somebody typing a passcode.
    request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(request as CFDictionary, nil)
  }
}
