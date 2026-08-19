import Foundation
import Security

/// Persistent storage behind a protocol so the identity rules can be tested without a Keychain,
/// which is not reliably available in a unit-test process.
public protocol IdentityStore: Sendable {
  func string(forKey key: String) -> String?
  func setString(_ value: String, forKey key: String)
}

/// The pair of values every camera on the field needs: a machine-owned identifier that never
/// changes, and a human label that can.
///
/// RFC 3550 already defines exactly this pair, so nothing here is invented. The UUID is carried as
/// the RTCP **CNAME** (§6.5.1) in RFC 7022's long-term persistent form, and the label as SDES
/// **NAME** (§6.5.2), "the real name used to describe the source … in any form desired by the user".
public struct DeviceIdentity: Sendable, Equatable, Codable {
  /// RFC 7022 §4.2: a version-4 UUID with `urn:uuid:` stripped, used as the host part of the CNAME
  /// with the `user@` part omitted, which §4.2 permits on a single-user system.
  public let uuid: String
  public var name: String

  public init(uuid: String, name: String) {
    self.uuid = uuid
    self.name = Self.normalized(name: name, uuid: uuid)
  }

  /// RFC 5576 requires the SDP `cname` and the RTCP SDES CNAME to be the same string, so there is
  /// deliberately only one source for both.
  public var cname: String { uuid }

  /// Deliberately *not* `UIDevice.current.name`. Since iOS 16 that returns the model name — a bare
  /// "iPhone" — without the `user-assigned-device-name` entitlement, so three phones on a field
  /// would all announce the same label.
  public static func defaultName(forUUID uuid: String) -> String {
    let compact = uuid.replacingOccurrences(of: "-", with: "")
    return "Camera \(compact.suffix(4).uppercased())"
  }

  /// RFC 4566 forbids an empty SDP session name, so a cleared field falls back to the default
  /// rather than emitting `s=` with nothing after it.
  public static func normalized(name: String, uuid: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    // CR and LF would terminate the SDP line early and split one field into two. A CRLF pair splits
    // into two separators with nothing between them, so empty pieces are dropped rather than joined,
    // which would otherwise leave a double space.
    let sanitised = trimmed
      .components(separatedBy: .newlines)
      .filter { !$0.isEmpty }
      .joined(separator: " ")
    return sanitised.isEmpty ? defaultName(forUUID: uuid) : sanitised
  }

  public static func generatedUUID() -> String {
    UUID().uuidString.lowercased()
  }
}

/// Loads the identity, creating and persisting it on first launch.
public struct DeviceIdentityProvider: Sendable {
  public static let uuidKey = "co.gamestation.cameraman.identity.uuid"
  public static let nameKey = "co.gamestation.cameraman.identity.name"

  private let store: IdentityStore

  public init(store: IdentityStore) {
    self.store = store
  }

  public func load() -> DeviceIdentity {
    let uuid: String
    if let stored = store.string(forKey: Self.uuidKey), Self.isWellFormed(uuid: stored) {
      uuid = stored
    } else {
      uuid = DeviceIdentity.generatedUUID()
      store.setString(uuid, forKey: Self.uuidKey)
    }
    let name = store.string(forKey: Self.nameKey) ?? DeviceIdentity.defaultName(forUUID: uuid)
    return DeviceIdentity(uuid: uuid, name: name)
  }

  @discardableResult
  public func save(name: String) -> DeviceIdentity {
    let identity = load()
    let normalised = DeviceIdentity.normalized(name: name, uuid: identity.uuid)
    store.setString(normalised, forKey: Self.nameKey)
    return DeviceIdentity(uuid: identity.uuid, name: normalised)
  }

  /// A UUID that survived a corrupt or truncated write must be rejected, because a malformed CNAME
  /// would make GS Producer bind two different phones to one record.
  public static func isWellFormed(uuid: String) -> Bool {
    guard uuid.count == 36, uuid == uuid.lowercased() else { return false }
    return UUID(uuidString: uuid) != nil
  }
}

/// Keychain-backed storage, so the identity survives a delete-and-reinstall of the app.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` because the server has to come back after an
/// unattended reboot, but the identity should never migrate to another handset in a backup.
public struct KeychainIdentityStore: IdentityStore {
  private let service: String

  public init(service: String = "co.gamestation.cameraman.identity") {
    self.service = service
  }

  public func string(forKey key: String) -> String? {
    var query = baseQuery(key: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  public func setString(_ value: String, forKey key: String) {
    let data = Data(value.utf8)
    let query = baseQuery(key: key)

    let updates: [String: Any] = [ kSecValueData as String: data ]
    let status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
    guard status != errSecSuccess else { return }

    var insert = query
    insert[kSecValueData as String] = data
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(insert as CFDictionary, nil)
  }

  private func baseQuery(key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key
    ]
  }
}

/// Test and simulator storage. Also the fallback when the Keychain refuses, which happens in a
/// unit-test host without a provisioned keychain.
public final class InMemoryIdentityStore: IdentityStore, @unchecked Sendable {
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
