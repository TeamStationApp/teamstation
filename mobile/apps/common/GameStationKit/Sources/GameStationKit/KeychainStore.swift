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
  private static let tokenKey = "gameStationToken"
  private static let eventKey = "gameStationChosenEvent"

  public init(service: String) {
    self.service = service
  }

  public func token() -> String? {
    guard let data = read(Self.tokenKey) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func setToken(_ token: String?) {
    write(Self.tokenKey, data: token?.data(using: .utf8))
  }

  public func chosenEvent() -> GameStationAccount.ChosenEvent? {
    guard let data = read(Self.eventKey) else { return nil }
    return try? GameStationClient.decoder.decode(
      GameStationAccount.ChosenEvent.self,
      from: data
    )
  }

  public func setChosenEvent(_ event: GameStationAccount.ChosenEvent?) {
    guard let event else {
      write(Self.eventKey, data: nil)
      return
    }
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    write(Self.eventKey, data: try? encoder.encode(event))
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
    var request = query(key)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess
    else { return nil }
    return item as? Data
  }

  private func write(_ key: String, data: Data?) {
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
