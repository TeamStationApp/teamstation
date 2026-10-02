import CameramanCore
import Foundation
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
    // TS Director.
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

  // MARK: - Carrying an existing phone over, and a store that fails

  private static let known = "3f2504e0-4f89-41d3-9a0c-0305e82c33ab"
  private static let other = "c94df9ca-d7c2-468f-8529-97d01fba14e7"

  @Test("An updated phone carries its Keychain UUID and name into the file, and keeps them")
  func legacyIdentityIsCarriedOver() {
    let file = InMemoryIdentityStore()
    let keychain = FailingIdentityStore(values: [
      DeviceIdentityProvider.uuidKey: Self.known,
      DeviceIdentityProvider.nameKey: "Corner Flag"
    ])

    let identity = DeviceIdentityProvider(store: file, legacy: keychain).load()

    #expect(identity.uuid == Self.known)
    #expect(identity.name == "Corner Flag")
    #expect(file.string(forKey: DeviceIdentityProvider.uuidKey) == Self.known)
    #expect(file.string(forKey: DeviceIdentityProvider.nameKey) == "Corner Flag")
    #expect(keychain.writes == 0)
    // From here on the file alone decides.
    #expect(DeviceIdentityProvider(store: file).load().uuid == Self.known)
  }

  @Test("Once the file has a UUID the old store is not consulted")
  func fileWinsOverLegacy() {
    let file = InMemoryIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.known ])
    let keychain = FailingIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.other ])

    #expect(DeviceIdentityProvider(store: file, legacy: keychain).load().uuid == Self.known)
  }

  @Test("A file that cannot be read is not written over, and the launch keeps one stand-in UUID")
  func unreadableFileIsLeftAlone() {
    // The file may still hold the real UUID. Writing over it would make this launch's stand-in
    // permanent.
    let file = FailingIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.known ])
    file.isReadable = false
    let provider = DeviceIdentityProvider(store: file)

    let first = provider.load().uuid
    #expect(DeviceIdentityProvider.isWellFormed(uuid: first))
    #expect(provider.load().uuid == first)
    #expect(file.writes == 0)

    file.isReadable = true
    #expect(DeviceIdentityProvider(store: file).load().uuid == Self.known)
  }

  @Test("A file that cannot be read still serves the old store's UUID when there is one")
  func unreadableFileFallsBackToLegacy() {
    let file = FailingIdentityStore()
    file.isReadable = false
    let keychain = FailingIdentityStore(values: [ DeviceIdentityProvider.uuidKey: Self.known ])

    #expect(DeviceIdentityProvider(store: file, legacy: keychain).load().uuid == Self.known)
    #expect(file.writes == 0)
  }

  // MARK: - The file itself

  private func temporaryFile() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("DeviceIdentityTests-\(UUID().uuidString)", isDirectory: true)
      .appendingPathComponent("identity.json")
  }

  @Test("The file keeps the UUID and name for the next launch")
  func fileRoundTrips() throws {
    let url = temporaryFile()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

    let first = DeviceIdentityProvider(store: FileIdentityStore(url: url)).load()
    DeviceIdentityProvider(store: FileIdentityStore(url: url)).save(name: "Corner Flag")
    let relaunched = DeviceIdentityProvider(store: FileIdentityStore(url: url)).load()

    #expect(relaunched.uuid == first.uuid)
    #expect(relaunched.name == "Corner Flag")
    let values = try url.resourceValues(forKeys: [ .isExcludedFromBackupKey ])
    #expect(values.isExcludedFromBackup == true)
  }

  @Test("A missing file is empty, and a file that does not decode is replaced")
  func missingAndCorruptFiles() throws {
    let url = temporaryFile()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let store = FileIdentityStore(url: url)
    #expect(store.read(forKey: DeviceIdentityProvider.uuidKey) == .notFound)

    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: url)
    let identity = DeviceIdentityProvider(store: store).load()

    #expect(DeviceIdentityProvider.isWellFormed(uuid: identity.uuid))
    #expect(FileIdentityStore(url: url).string(forKey: DeviceIdentityProvider.uuidKey) == identity.uuid)
  }
}

/// A store that can be made unreadable or read-only.
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
