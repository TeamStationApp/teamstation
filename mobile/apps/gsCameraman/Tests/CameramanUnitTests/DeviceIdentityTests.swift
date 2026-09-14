import CameramanCore
import Foundation
import Security
import Testing

@Suite("Device identity")
struct DeviceIdentityTests {
  @Test("A first launch mints a UUID and persists it")
  func firstLaunchMintsIdentity() {
    let store = InMemoryIdentityStore()
    let provider = DeviceIdentityProvider(store: store)

    let identity = provider.load()

    #expect(DeviceIdentityProvider.isWellFormed(uuid: identity.uuid))
    #expect(store.string(forKey: DeviceIdentityProvider.uuidKey) == identity.uuid)
  }

  @Test("The UUID is stable across loads, because the CNAME must not change mid-session")
  func uuidIsStable() {
    let store = InMemoryIdentityStore()
    let provider = DeviceIdentityProvider(store: store)

    #expect(provider.load().uuid == provider.load().uuid)
  }

  @Test("A stored UUID that is malformed is replaced rather than served")
  func malformedUUIDIsReplaced() {
    // A truncated write would otherwise become a CNAME that binds two phones to one record in
    // GS Producer.
    let store = InMemoryIdentityStore(values: [
      DeviceIdentityProvider.uuidKey: "not-a-uuid"
    ])
    let identity = DeviceIdentityProvider(store: store).load()

    #expect(identity.uuid != "not-a-uuid")
    #expect(DeviceIdentityProvider.isWellFormed(uuid: identity.uuid))
  }

  @Test("An upper-case stored UUID is rejected, so the CNAME has one canonical form")
  func upperCaseUUIDIsRejected() {
    let upper = UUID().uuidString
    #expect(!DeviceIdentityProvider.isWellFormed(uuid: upper))
    #expect(DeviceIdentityProvider.isWellFormed(uuid: upper.lowercased()))
  }

  @Test("The default name is derived from the UUID, not from UIDevice")
  func defaultName() {
    // Since iOS 16 `UIDevice.current.name` returns a bare "iPhone" without a special entitlement,
    // so three phones on one field would all announce the same label.
    let name = DeviceIdentity.defaultName(forUUID: "3f2504e0-4f89-41d3-9a0c-0305e82c33ab")
    #expect(name == "Camera 33AB")
  }

  @Test("A name survives a rename and is returned on the next load")
  func renamePersists() {
    let store = InMemoryIdentityStore()
    let provider = DeviceIdentityProvider(store: store)
    let original = provider.load()

    let renamed = provider.save(name: "Corner Flag")

    #expect(renamed.name == "Corner Flag")
    #expect(renamed.uuid == original.uuid)
    #expect(provider.load().name == "Corner Flag")
  }

  @Test("An empty name falls back to the default, because SDP forbids an empty s= line")
  func emptyNameFallsBack() {
    let store = InMemoryIdentityStore()
    let provider = DeviceIdentityProvider(store: store)
    let uuid = provider.load().uuid

    #expect(provider.save(name: "   ").name == DeviceIdentity.defaultName(forUUID: uuid))
  }

  @Test("Newlines in a name are flattened so they cannot split an SDP line in two")
  func newlinesAreFlattened() {
    let identity = DeviceIdentity(uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c33ab", name: "Half\r\nLine")
    #expect(identity.name == "Half Line")
    #expect(!identity.name.contains("\n"))
    #expect(!identity.name.contains("\r"))
  }

  @Test("Surrounding whitespace is trimmed but inner spacing is left alone")
  func trimming() {
    let identity = DeviceIdentity(uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c33ab", name: "  Left Wing  ")
    #expect(identity.name == "Left Wing")
  }

  @Test("The CNAME is the UUID, because RFC 5576 requires SDP and RTCP to agree")
  func cnameMatchesUUID() {
    let identity = DeviceIdentity(uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c33ab", name: "Corner Flag")
    #expect(identity.cname == identity.uuid)
  }

  // MARK: - A store that fails

  private static let known = "3f2504e0-4f89-41d3-9a0c-0305e82c33ab"
  private static let other = "c94df9ca-d7c2-468f-8529-97d01fba14e7"

  @Test("A first launch writes the new UUID to the Keychain and the mirror")
  func firstLaunchWritesBoth() {
    let keychain = FailingIdentityStore()
    let mirror = InMemoryIdentityStore()

    let uuid = DeviceIdentityProvider(store: keychain, mirror: mirror).load().uuid

    #expect(keychain.string(forKey: DeviceIdentityProvider.uuidKey) == uuid)
    #expect(mirror.string(forKey: DeviceIdentityProvider.uuidKey) == uuid)
  }

  @Test("An unreadable Keychain with a mirrored UUID uses the mirror and overwrites nothing")
  func unreadableKeychainUsesMirror() {
    let keychain = FailingIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.other ])
    keychain.isReadable = false
    let mirror = FailingIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.known ])

    let identity = DeviceIdentityProvider(store: keychain, mirror: mirror).load()

    #expect(identity.uuid == Self.known)
    #expect(keychain.writes == 0)
    #expect(mirror.writes == 0)
  }

  @Test("An unreadable Keychain with no mirror mints into the mirror only, and keeps it")
  func unreadableKeychainWithoutMirrorNeverWritesKeychain() {
    // The Keychain may still hold the real UUID. Writing over it would make this launch's stand-in
    // permanent.
    let keychain = FailingIdentityStore()
    keychain.isReadable = false
    let mirror = InMemoryIdentityStore()

    let first = DeviceIdentityProvider(store: keychain, mirror: mirror).load().uuid
    let second = DeviceIdentityProvider(store: keychain, mirror: mirror).load().uuid

    #expect(DeviceIdentityProvider.isWellFormed(uuid: first))
    #expect(first == second)
    #expect(keychain.writes == 0)
    #expect(mirror.string(forKey: DeviceIdentityProvider.uuidKey) == first)
  }

  @Test("The Keychain takes over again once it can be read")
  func keychainWinsOverMirror() {
    let keychain = FailingIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.known ])
    let mirror = InMemoryIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.other ])

    let identity = DeviceIdentityProvider(store: keychain, mirror: mirror).load()

    #expect(identity.uuid == Self.known)
    #expect(mirror.string(forKey: DeviceIdentityProvider.uuidKey) == Self.known)
    #expect(keychain.writes == 0)
  }

  @Test("An install that predates the mirror copies the Keychain UUID into it")
  func existingKeychainUUIDFillsMirror() {
    let keychain = FailingIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.known ])
    let mirror = InMemoryIdentityStore()

    _ = DeviceIdentityProvider(store: keychain, mirror: mirror).load()

    #expect(mirror.string(forKey: DeviceIdentityProvider.uuidKey) == Self.known)
  }

  @Test("A UUID missing from the Keychain is restored from the mirror, not replaced")
  func missingKeychainUUIDIsRestored() {
    let keychain = FailingIdentityStore()
    let mirror = InMemoryIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.known ])

    let identity = DeviceIdentityProvider(store: keychain, mirror: mirror).load()

    #expect(identity.uuid == Self.known)
    #expect(keychain.string(forKey: DeviceIdentityProvider.uuidKey) == Self.known)
  }

  @Test("A Keychain write that fails does not change the UUID on the next launch")
  func failedKeychainWriteKeepsUUID() {
    let keychain = FailingIdentityStore()
    keychain.acceptsWrites = false
    let mirror = InMemoryIdentityStore()

    let first = DeviceIdentityProvider(store: keychain, mirror: mirror).load().uuid
    keychain.acceptsWrites = true
    let second = DeviceIdentityProvider(store: keychain, mirror: mirror).load().uuid

    #expect(first == second)
    #expect(keychain.string(forKey: DeviceIdentityProvider.uuidKey) == first)
  }

  @Test("The operator's name comes from the mirror while the Keychain is unreadable")
  func nameFromMirror() {
    let keychain = FailingIdentityStore()
    keychain.isReadable = false
    let mirror = InMemoryIdentityStore(values: [
      DeviceIdentityProvider.uuidKey: Self.known,
      DeviceIdentityProvider.nameKey: "Corner Flag"
    ])

    #expect(DeviceIdentityProvider(store: keychain, mirror: mirror).load().name == "Corner Flag")
  }

  @Test("Only item-not-found reads as an empty Keychain")
  func keychainStatuses() {
    #expect(KeychainIdentityStore.interpret(status: errSecItemNotFound, data: nil) == .notFound)
    #expect(KeychainIdentityStore.interpret(status: errSecInteractionNotAllowed, data: nil).isUnreadable)
    #expect(KeychainIdentityStore.interpret(status: errSecMissingEntitlement, data: nil).isUnreadable)
    #expect(KeychainIdentityStore.interpret(status: errSecSuccess, data: Data(Self.known.utf8)) == .found(Self.known))
    // Corrupt bytes are a value to replace, not a store to leave alone.
    #expect(!KeychainIdentityStore.interpret(status: errSecSuccess, data: Data([ 0xff, 0xfe ])).isUnreadable)
  }
}

/// A store that can be made unreadable or read-only, the two ways the Keychain fails.
private final class FailingIdentityStore: IdentityStore, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: String]
  private var readable = true
  private var writable = true
  private var writeCount = 0

  init(values: [String: String] = [:]) {
    self.values = values
  }

  var isReadable: Bool {
    get { lock.withLock { readable } }
    set { lock.withLock { readable = newValue } }
  }

  var acceptsWrites: Bool {
    get { lock.withLock { writable } }
    set { lock.withLock { writable = newValue } }
  }

  var writes: Int { lock.withLock { writeCount } }

  func read(forKey key: String) -> IdentityRead {
    lock.withLock { () -> IdentityRead in
      guard readable else { return .unreadable("errSecInteractionNotAllowed") }
      return values[key].map { IdentityRead.found($0) } ?? .notFound
    }
  }

  @discardableResult
  func setString(_ value: String, forKey key: String) -> Bool {
    lock.withLock { () -> Bool in
      writeCount += 1
      guard writable else { return false }
      values[key] = value
      return true
    }
  }
}
