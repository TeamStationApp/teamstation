import Foundation
import ProducerCore
import ProducerSources
import Testing

@Suite("Camera registry")
struct CameraRegistryTests {
  private func registry() -> CameraRegistry {
    let suite = "co.gamestation.producer.tests.\(UUID().uuidString)"
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
}
