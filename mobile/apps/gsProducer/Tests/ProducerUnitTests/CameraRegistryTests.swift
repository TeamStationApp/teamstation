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
    let endpoint = CameraEndpoint(host: "192.168.7.244")
    let advertisement = CameraAdvertisement(
      host: "192.168.7.244",
      advertisedName: "00002 Mound",
      modelName: "VM33_00002"
    )

    _ = cameras.resolve(endpoints: [ endpoint ], advertisements: [ advertisement ])
    let forgotten = cameras.records[0].id
    cameras.forget(forgotten)
    _ = cameras.resolve(endpoints: [ endpoint ], advertisements: [])

    #expect(cameras.records.count == 1)
    #expect(cameras.records[0].id != forgotten)
    #expect(cameras.records[0].name == "00002 Mound")
    #expect(cameras.bindings[0].origin == .autoByIdentity)
  }

  @Test("A later browse without TXT does not forget the unique id already learned")
  func emptyTXTDoesNotWipeIdentity() {
    let cameras = registry()
    let endpoint = CameraEndpoint(host: "192.168.7.244")
    _ = cameras.resolve(
      endpoints: [ endpoint ],
      advertisements: [
        CameraAdvertisement(
          host: "192.168.7.244",
          advertisedName: "00002 Mound",
          modelName: "VM33_00002"
        )
      ]
    )
    _ = cameras.resolve(
      endpoints: [ endpoint ],
      advertisements: [
        CameraAdvertisement(host: "192.168.7.244", advertisedName: "00002 Mound")
      ]
    )
    cameras.forget(cameras.records[0].id)

    #expect(cameras.records[0].name == "00002 Mound")
    #expect(cameras.bindings[0].origin == .autoByIdentity)
  }

  @Test("A CNAME claimed on the wire rebinds the camera after it moves")
  func noteCNAMERebindsAfterMove() {
    let cameras = registry()
    let first = CameraEndpoint(host: "192.168.8.2")
    let moved = CameraEndpoint(host: "192.168.8.9")
    let claim = StreamAdvertisement(cname: "phone@gs-cameraman", name: "iPhone 13 Pro")

    _ = cameras.resolve(endpoints: [ first ])
    let id = cameras.adopt(endpoint: first, name: "Sideline")
    cameras.note(claim, from: first)
    cameras.rename(id, to: "Sideline")

    _ = cameras.resolve(endpoints: [ moved ])
    cameras.note(claim, from: moved)
    _ = cameras.resolve(endpoints: [ moved ])

    #expect(cameras.record(id: id)?.lastKnownCNAME == "phone@gs-cameraman")
    #expect(cameras.record(id: id)?.advertisedName == "iPhone 13 Pro")
    #expect(cameras.record(id: id)?.name == "Sideline")
    #expect(cameras.binding(for: moved)?.cameraID == id)
    #expect(cameras.binding(for: moved)?.origin == .autoByCNAME)
  }
}
