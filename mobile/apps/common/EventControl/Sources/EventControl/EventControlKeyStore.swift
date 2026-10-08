import Foundation
import Security

/// Where a device keeps its event-control key: the keychain, under a service the app names
/// (`app.teamstation.director.eventcontrol`, `app.teamstation.cameraman.eventcontrol`), one item per
/// account server.
///
/// The record holds the account scope with the key, so a device relaunched offline still knows
/// which account it proved and can keep taking part on the local network. Never settings, exports
/// or advertisements.
public struct EventControlKeyStore: Sendable {
  public let service: String
  private let memory: Memory?

  public init(service: String) {
    self.service = service
    memory = nil
  }

  /// A store that never touches the keychain, for tests and previews.
  public static func inMemory() -> EventControlKeyStore {
    EventControlKeyStore(memory: Memory())
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

    func removeAll() {
      lock.withLock { items = [:] }
    }
  }

  /// The key cached for a server, by its canonical origin
  /// (`EventControlCredentials.canonicalOrigin(of:)`).
  public func credentials(for server: String) -> EventControlCredentials? {
    guard let data = read(server) else { return nil }
    return try? JSONDecoder().decode(EventControlCredentials.self, from: data)
  }

  /// Keeps `credentials` for a server, replacing what was there. False if the keychain refused.
  @discardableResult
  public func save(_ credentials: EventControlCredentials, for server: String) -> Bool {
    guard let data = try? JSONEncoder().encode(credentials) else { return false }
    return write(server, data: data)
  }

  /// Forgets a server's key: on sign-out, another account, or a key the server no longer issues.
  public func remove(for server: String) {
    _ = write(server, data: nil)
  }

  /// Forgets every key this service holds.
  public func removeAll() {
    if let memory {
      memory.removeAll()
      return
    }
    SecItemDelete([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service
    ] as CFDictionary)
  }

  // MARK: - The keychain itself

  private func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
  }

  private func read(_ account: String) -> Data? {
    if let memory { return memory[account] }
    var request = query(account)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess else { return nil }
    return item as? Data
  }

  private func write(_ account: String, data: Data?) -> Bool {
    if let memory {
      memory[account] = data
      return true
    }
    SecItemDelete(query(account) as CFDictionary)
    guard let data else { return true }
    var request = query(account)
    request[kSecValueData as String] = data
    // Readable after the first unlock, so a device relaunched in a bag mid-game still has it, and
    // never synced or backed up to another device.
    request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(request as CFDictionary, nil) == errSecSuccess
  }
}
