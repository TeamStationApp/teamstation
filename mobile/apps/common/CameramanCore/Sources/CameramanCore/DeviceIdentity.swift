import Foundation
import Security

/// What a store found under a key. A store that could not be read is not a store that is empty:
/// treating the two alike would mint a new identity whenever the Keychain refused a read, and the
/// phone would come back as a camera Director has never seen.
public enum IdentityRead: Sendable, Equatable {
  case found(String)
  case notFound
  case unreadable(String)

  public var value: String? {
    if case .found(let value) = self { return value }
    return nil
  }

  public var isUnreadable: Bool {
    if case .unreadable = self { return true }
    return false
  }
}

/// Persistent storage behind a protocol so the identity rules can be tested without a Keychain,
/// which is not reliably available in a unit-test process.
public protocol IdentityStore: Sendable {
  func read(forKey key: String) -> IdentityRead
  /// False when the value did not reach storage.
  @discardableResult
  func setString(_ value: String, forKey key: String) -> Bool
}

extension IdentityStore {
  /// The stored value, or nil when there is none or it could not be read.
  public func string(forKey key: String) -> String? {
    read(forKey: key).value
  }
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
///
/// Two stores, because either can fail while the other works. `store` is authoritative — the
/// Keychain, which survives a delete-and-reinstall. `mirror` is a per-install copy that can be read
/// on a launch where the Keychain cannot. A UUID is minted only when neither holds one, and a store
/// that could not be read is never written over, because it may still hold the real UUID.
public struct DeviceIdentityProvider: Sendable {
  public static let uuidKey = "co.gamestation.cameraman.identity.uuid"
  public static let nameKey = "co.gamestation.cameraman.identity.name"

  private let store: IdentityStore
  private let mirror: IdentityStore

  /// The default mirror lives in memory, which still keeps one UUID for the life of the process
  /// when `store` cannot be read.
  public init(store: IdentityStore, mirror: IdentityStore = InMemoryIdentityStore()) {
    self.store = store
    self.mirror = mirror
  }

  public func load() -> DeviceIdentity {
    let uuid = loadUUID()
    let name = loadName() ?? DeviceIdentity.defaultName(forUUID: uuid)
    return DeviceIdentity(uuid: uuid, name: name)
  }

  @discardableResult
  public func save(name: String) -> DeviceIdentity {
    let identity = load()
    let normalised = DeviceIdentity.normalized(name: name, uuid: identity.uuid)
    store.setString(normalised, forKey: Self.nameKey)
    mirror.setString(normalised, forKey: Self.nameKey)
    return DeviceIdentity(uuid: identity.uuid, name: normalised)
  }

  /// A UUID that survived a corrupt or truncated write must be rejected, because a malformed CNAME
  /// would make GS Producer bind two different phones to one record.
  public static func isWellFormed(uuid: String) -> Bool {
    guard uuid.count == 36, uuid == uuid.lowercased() else { return false }
    return UUID(uuidString: uuid) != nil
  }

  private func loadUUID() -> String {
    let primary = store.read(forKey: Self.uuidKey)
    let mirrored = mirror.read(forKey: Self.uuidKey).value.flatMap(Self.wellFormed)

    if let stored = primary.value.flatMap(Self.wellFormed) {
      // An install that predates the mirror, or a mirror that drifted: the Keychain wins.
      if mirrored != stored { mirror.setString(stored, forKey: Self.uuidKey) }
      return stored
    }
    if let mirrored {
      // Missing or malformed in the store, most likely a write that failed: put it back. An
      // unreadable store is left alone.
      if !primary.isUnreadable { store.setString(mirrored, forKey: Self.uuidKey) }
      return mirrored
    }

    let minted = DeviceIdentity.generatedUUID()
    // An unreadable store may still hold the real UUID, so the new one goes to the mirror alone and
    // the store's copy takes over again on the first launch that can read it.
    if !primary.isUnreadable { store.setString(minted, forKey: Self.uuidKey) }
    mirror.setString(minted, forKey: Self.uuidKey)
    return minted
  }

  private func loadName() -> String? {
    if let stored = store.read(forKey: Self.nameKey).value {
      if mirror.read(forKey: Self.nameKey).value != stored {
        mirror.setString(stored, forKey: Self.nameKey)
      }
      return stored
    }
    return mirror.read(forKey: Self.nameKey).value
  }

  private static func wellFormed(_ uuid: String) -> String? {
    isWellFormed(uuid: uuid) ? uuid : nil
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

  public func read(forKey key: String) -> IdentityRead {
    var query = baseQuery(key: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    return Self.interpret(status: status, data: item as? Data)
  }

  /// Only `errSecItemNotFound` means there is no value. Any other failure —
  /// `errSecInteractionNotAllowed` before the first unlock after a reboot, a missing entitlement —
  /// means there may be one this launch cannot see.
  public static func interpret(status: OSStatus, data: Data?) -> IdentityRead {
    switch status {
    case errSecSuccess:
      // Bytes that are not UTF-8 are a corrupt value rather than an unreadable one. Read as found,
      // they fail the well-formed check and are replaced.
      return .found(data.map { String(decoding: $0, as: UTF8.self) } ?? "")
    case errSecItemNotFound:
      return .notFound
    default:
      let message = SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
      return .unreadable("OSStatus \(status): \(message)")
    }
  }

  @discardableResult
  public func setString(_ value: String, forKey key: String) -> Bool {
    let data = Data(value.utf8)
    let query = baseQuery(key: key)

    let updates: [String: Any] = [ kSecValueData as String: data ]
    let status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
    guard status == errSecItemNotFound else { return status == errSecSuccess }

    var insert = query
    insert[kSecValueData as String] = data
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
  }

  private func baseQuery(key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key
    ]
  }
}

/// The per-install mirror of the Keychain values. It goes away with the app, which is the right
/// lifetime for a copy: after a reinstall the Keychain alone decides.
///
/// `@unchecked` because `UserDefaults` is documented as thread-safe but not marked `Sendable`.
public struct UserDefaultsIdentityStore: IdentityStore, @unchecked Sendable {
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func read(forKey key: String) -> IdentityRead {
    defaults.string(forKey: key).map { IdentityRead.found($0) } ?? .notFound
  }

  @discardableResult
  public func setString(_ value: String, forKey key: String) -> Bool {
    defaults.set(value, forKey: key)
    return true
  }
}

/// Test and simulator storage, and the default mirror.
public final class InMemoryIdentityStore: IdentityStore, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: String]

  public init(values: [String: String] = [:]) {
    self.values = values
  }

  public func read(forKey key: String) -> IdentityRead {
    lock.withLock { values[key] }.map { IdentityRead.found($0) } ?? .notFound
  }

  @discardableResult
  public func setString(_ value: String, forKey key: String) -> Bool {
    lock.withLock { values[key] = value }
    return true
  }
}
