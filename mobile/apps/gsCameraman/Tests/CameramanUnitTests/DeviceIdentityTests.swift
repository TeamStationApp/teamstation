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
}
