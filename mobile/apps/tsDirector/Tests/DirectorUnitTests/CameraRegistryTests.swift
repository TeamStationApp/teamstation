import Foundation
import DirectorCore
import DirectorSources
import Testing

@Suite("Camera registry")
struct CameraRegistryTests {
  private func registry() -> CameraRegistry {
    let suite = "app.teamstation.director.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return CameraRegistry(store: CameraRecordStore(store: ConfigStore(defaults: defaults)))
  }

  @Test("Forgetting re-adopts from the last TXT snapshot when Bonjour is empty this instant")
  func forgetReadoptsFromRememberedAdvertisements() {
    let cameras = registry()
    let endpoint = CameraEndpoint(host: "10.10.7.244")
    let advertisement = CameraAdvertisement(
      host: "10.10.7.244",
      advertisedName: "0107B Mound",
      modelName: "VM33_0107B"
    )

    _ = cameras.resolve(endpoints: [ endpoint ], advertisements: [ advertisement ])
    let forgotten = cameras.records[0].id
    cameras.forget(forgotten)
    _ = cameras.resolve(endpoints: [ endpoint ], advertisements: [])

    #expect(cameras.records.count == 1)
    #expect(cameras.records[0].id != forgotten)
    #expect(cameras.records[0].name == "0107B Mound")
    #expect(cameras.bindings[0].origin == .autoByIdentity)
  }

  @Test("A later browse without TXT does not forget the unique id already learned")
  func emptyTXTDoesNotWipeIdentity() {
    let cameras = registry()
    let endpoint = CameraEndpoint(host: "10.10.7.244")
    _ = cameras.resolve(
      endpoints: [ endpoint ],
      advertisements: [
        CameraAdvertisement(
          host: "10.10.7.244",
          advertisedName: "0107B Mound",
          modelName: "VM33_0107B"
        )
      ]
    )
    _ = cameras.resolve(
      endpoints: [ endpoint ],
      advertisements: [
        CameraAdvertisement(host: "10.10.7.244", advertisedName: "0107B Mound")
      ]
    )
    cameras.forget(cameras.records[0].id)

    #expect(cameras.records[0].name == "0107B Mound")
    #expect(cameras.bindings[0].origin == .autoByIdentity)
  }

  @Test("A CNAME claimed on the wire rebinds the camera after it moves")
  func noteCNAMERebindsAfterMove() {
    let cameras = registry()
    let first = CameraEndpoint(host: "10.10.8.2")
    let moved = CameraEndpoint(host: "10.10.8.9")
    let claim = StreamAdvertisement(cname: "phone@ts-cameraman", name: "iPhone 13 Pro")

    _ = cameras.resolve(endpoints: [ first ])
    let id = cameras.adopt(endpoint: first, name: "Sideline")
    cameras.note(claim, from: first)
    cameras.rename(id, to: "Sideline")

    _ = cameras.resolve(endpoints: [ moved ])
    cameras.note(claim, from: moved)
    _ = cameras.resolve(endpoints: [ moved ])

    #expect(cameras.record(id: id)?.lastKnownCNAME == "phone@ts-cameraman")
    #expect(cameras.record(id: id)?.advertisedName == "iPhone 13 Pro")
    #expect(cameras.record(id: id)?.name == "Sideline")
    #expect(cameras.binding(for: moved)?.cameraID == id)
    #expect(cameras.binding(for: moved)?.origin == .autoByCNAME)
  }

  @Test("An IP-only name is not written to disk")
  func adoptWithoutIdentityDoesNotPersist() {
    let suite = "app.teamstation.director.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let store = CameraRecordStore(store: ConfigStore(defaults: defaults))
    let cameras = CameraRegistry(store: store)

    _ = cameras.adopt(endpoint: CameraEndpoint(host: "10.10.7.99"), name: "Scratch")

    #expect(cameras.records.count == 1)
    #expect(!cameras.records[0].hasHardenedIdentity)
    #expect(store.load().isEmpty)
    #expect(CameraRegistry(store: store).records.isEmpty)
  }

  @Test("An unidentified socket is named Unnamed and keyed by a session id, not the IP")
  func unidentifiedSocketIsNotAddressKeyed() {
    let cameras = registry()
    let endpoint = CameraEndpoint(host: "10.10.7.99")
    let identities = cameras.resolve(endpoints: [ endpoint ])

    #expect(identities[endpoint]?.name == CameraIdentityRules.unnamedFallback)
    #expect(identities[endpoint].map { CameraIdentityRules.isSessionIdentity($0.id) } == true)
    #expect(identities[endpoint]?.id.rawValue.contains("10.10.7.99") != true)
    #expect(cameras.resolve(endpoints: [ endpoint ])[endpoint]?.id == identities[endpoint]?.id)
  }

  @Test("Clearing the registry empties the store")
  func clearEmptiesTheStore() {
    let suite = "app.teamstation.director.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let store = CameraRecordStore(store: ConfigStore(defaults: defaults))
    let cameras = CameraRegistry(store: store)
    _ = cameras.resolve(
      endpoints: [ CameraEndpoint(host: "10.10.7.244") ],
      advertisements: [
        CameraAdvertisement(
          host: "10.10.7.244",
          advertisedName: "0107B Mound",
          modelName: "VM33_0107B"
        )
      ]
    )
    #expect(!store.load().isEmpty)
    cameras.clear()
    #expect(cameras.records.isEmpty)
    #expect(cameras.bindings.isEmpty)
    #expect(store.load().isEmpty)
  }

  @Test("A Cameraman found only by the sweep keeps the operator's name through its CNAME")
  func sweptCameramanIsNamedByItsCNAME() {
    let suite = "app.teamstation.director.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let store = CameraRecordStore(store: ConfigStore(defaults: defaults))
    let uuid = "258bf622-da23-4f23-bbba-1b42440dddf1"

    let cameras = CameraRegistry(store: store)
    let first = CameraEndpoint(host: "10.10.6.123", port: 8554)
    _ = cameras.resolve(
      endpoints: [ first ],
      advertisements: [
        CameraAdvertisement(host: "10.10.6.123", advertisedName: "Pixel10", port: 8554, uuid: uuid)
      ]
    )
    let id = cameras.records[0].id
    cameras.rename(id, to: "1st")

    // Next launch: the phone has a new lease and none of its Bonjour reaches the iPad.
    let relaunched = CameraRegistry(store: store)
    let moved = CameraEndpoint(host: "10.10.6.140", port: 8554)
    let identities = relaunched.resolve(
      endpoints: [ moved ],
      streamAdvertisements: [ moved: StreamAdvertisement(cname: uuid, name: "Pixel10") ]
    )

    #expect(identities[moved]?.name == "1st")
    #expect(identities[moved]?.id == SourceID(id.uuidString))
    #expect(relaunched.binding(for: moved)?.origin == .autoByCNAME)
    #expect(relaunched.records.count == 1)
  }

  @Test("A remembered advertisement does not name the phone that was given its address")
  func rememberedAdvertisementDoesNotNameTheNextPhone() {
    let cameras = registry()
    let pixel = "258bf622-da23-4f23-bbba-1b42440dddf1"
    let iPhone = "b11d5d5f-07e6-4802-a880-9a3a5ffd0e29"
    let socket = CameraEndpoint(host: "10.10.6.123", port: 8554)

    _ = cameras.resolve(
      endpoints: [ socket ],
      advertisements: [
        CameraAdvertisement(host: "10.10.6.123", advertisedName: "Pixel10", port: 8554, uuid: pixel)
      ],
      streamAdvertisements: [ socket: StreamAdvertisement(cname: pixel, name: "Pixel10") ]
    )

    // The Pixel leaves; its advertisement is still remembered when the iPhone takes the lease.
    let identities = cameras.resolve(
      endpoints: [ socket ],
      streamAdvertisements: [ socket: StreamAdvertisement(cname: iPhone, name: "iPhone15") ]
    )

    let iPhoneRecord = cameras.records.first { $0.lastKnownCNAME == iPhone }
    #expect(identities[socket]?.name == "iPhone15")
    #expect(cameras.binding(for: socket)?.cameraID == iPhoneRecord?.id)
    #expect(cameras.binding(for: socket)?.origin == .autoByCNAME)
  }
}
