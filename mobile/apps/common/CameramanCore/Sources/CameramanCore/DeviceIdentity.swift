import Foundation
import Security

/// What a store found under a key. A store that could not be read is not a store that is empty:
/// treating the two alike would mint a new identity whenever the file could not be read, and the
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

/// Persistent storage behind a protocol so the identity rules can be tested without touching the
/// app's real storage.
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
/// `store` is where the identity lives — a file in the app's own storage. `legacy` is where builds
/// before the file kept it, read only while the file has no UUID, so a phone that updates is still
/// the camera TS Director already knows. A store that exists but cannot be read is never written
/// over, since it still holds the real UUID; that launch runs on a stand-in kept for the process.
public struct DeviceIdentityProvider: Sendable {
  public static let uuidKey = "app.teamstation.cameraman.identity.uuid"
  public static let nameKey = "app.teamstation.cameraman.identity.name"

  private let store: IdentityStore
  private let legacy: IdentityStore?
  private let standIn = InMemoryIdentityStore()

  public init(store: IdentityStore, legacy: IdentityStore? = nil) {
    self.store = store
    self.legacy = legacy
  }

  public func load() -> DeviceIdentity {
    let read = store.read(forKey: Self.uuidKey)
    if let stored = read.value.flatMap(Self.wellFormed) {
      let name = store.string(forKey: Self.nameKey) ?? DeviceIdentity.defaultName(forUUID: stored)
      return DeviceIdentity(uuid: stored, name: name)
    }

    let carried = legacy?.string(forKey: Self.uuidKey).flatMap(Self.wellFormed)
    let carriedName = carried == nil ? nil : legacy?.string(forKey: Self.nameKey)

    guard !read.isUnreadable else {
      let uuid = standIn.string(forKey: Self.uuidKey) ?? carried ?? DeviceIdentity.generatedUUID()
      standIn.setString(uuid, forKey: Self.uuidKey)
      return DeviceIdentity(uuid: uuid, name: carriedName ?? DeviceIdentity.defaultName(forUUID: uuid))
    }

    let uuid = carried ?? DeviceIdentity.generatedUUID()
    store.setString(uuid, forKey: Self.uuidKey)
    var name = store.string(forKey: Self.nameKey)
    if name == nil, let carriedName {
      store.setString(carriedName, forKey: Self.nameKey)
      name = carriedName
    }
    return DeviceIdentity(uuid: uuid, name: name ?? DeviceIdentity.defaultName(forUUID: uuid))
  }

  @discardableResult
  public func save(name: String) -> DeviceIdentity {
    let identity = load()
    let normalised = DeviceIdentity.normalized(name: name, uuid: identity.uuid)
    store.setString(normalised, forKey: Self.nameKey)
    return DeviceIdentity(uuid: identity.uuid, name: normalised)
  }

  /// A UUID that survived a corrupt or truncated write must be rejected, because a malformed CNAME
  /// would make TS Director bind two different phones to one record.
  public static func isWellFormed(uuid: String) -> Bool {
    guard uuid.count == 36, uuid == uuid.lowercased() else { return false }
    return UUID(uuidString: uuid) != nil
  }

  private static func wellFormed(_ uuid: String) -> String? {
    isWellFormed(uuid: uuid) ? uuid : nil
  }
}

/// The identity as one small JSON file in the app's own storage.
///
/// Nothing in it is secret, so a plain file is all it needs. It lives and dies with the install: an
/// update keeps it, a delete-and-reinstall is a new camera. It is excluded from backups, so restoring
/// one phone's backup onto another cannot leave two phones announcing the same UUID.
public final class FileIdentityStore: IdentityStore, @unchecked Sendable {
  private let url: URL
  private let lock = NSLock()

  public init(url: URL = FileIdentityStore.defaultURL) {
    self.url = url
  }

  /// `Application Support/Identity/identity.json`.
  public static var defaultURL: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base
      .appendingPathComponent("Identity", isDirectory: true)
      .appendingPathComponent("identity.json", isDirectory: false)
  }

  public func read(forKey key: String) -> IdentityRead {
    lock.withLock {
      switch contents() {
      case .values(let values): values[key].map { IdentityRead.found($0) } ?? .notFound
      case .unreadable(let reason): .unreadable(reason)
      }
    }
  }

  @discardableResult
  public func setString(_ value: String, forKey key: String) -> Bool {
    lock.withLock {
      guard case .values(var values) = contents() else { return false }
      values[key] = value
      do {
        try FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [ .prettyPrinted, .sortedKeys ]
        try encoder.encode(values).write(to: url, options: .atomic)
        // Set after the write: an atomic write replaces the file, and the flag belongs to the file.
        var resource = URLResourceValues()
        resource.isExcludedFromBackup = true
        var written = url
        try written.setResourceValues(resource)
        return true
      } catch {
        return false
      }
    }
  }

  private enum Contents {
    case values([String: String])
    case unreadable(String)
  }

  private func contents() -> Contents {
    guard FileManager.default.fileExists(atPath: url.path) else { return .values([:]) }
    do {
      let data = try Data(contentsOf: url)
      // Contents that do not decode are a value to replace, not a file to protect.
      return .values((try? JSONDecoder().decode([String: String].self, from: data)) ?? [:])
    } catch {
      return .unreadable(error.localizedDescription)
    }
  }
}

/// Where builds before `FileIdentityStore` kept the identity. Read once, to carry an existing phone's
/// UUID and name into the file; never written, and nothing new is ever stored here.
public struct LegacyKeychainIdentityStore: IdentityStore {
  private let service: String

  public init(service: String = "app.teamstation.cameraman.identity") {
    self.service = service
  }

  public func read(forKey key: String) -> IdentityRead {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var item: CFTypeRef?
    switch SecItemCopyMatching(query as CFDictionary, &item) {
    case errSecSuccess:
      return (item as? Data).map { .found(String(decoding: $0, as: UTF8.self)) } ?? .notFound
    case errSecItemNotFound:
      return .notFound
    case let status:
      return .unreadable("OSStatus \(status)")
    }
  }

  @discardableResult
  public func setString(_ value: String, forKey key: String) -> Bool { false }
}

/// Test storage, pinned identities, and the provider's stand-in for a launch that cannot read its file.
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
