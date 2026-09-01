import Foundation
import Testing

import DirectorSources

/// The rules Director applies to the name and identifier Cameraman advertises. Pure value logic,
/// so it is compiled and run here rather than waiting for the Director app to be built.
struct CameraIdentityAdoptionTests {
  private let now = Date(timeIntervalSince1970: 1_700_000_000)
  private let cname = "3f2504e04f8911d3@gs-cameraman"

  private func adopted(name: String? = "Third Base") -> (UUID, [CameraRecord]) {
    var records: [CameraRecord] = []
    let id = CameraIdentityRules.makeRecord(
      adopting: StreamAdvertisement(cname: cname, name: name),
      host: "10.0.0.4",
      now: now,
      in: &records
    )
    return (id, records)
  }

  @Test func aCameraThatIntroducesItselfIsTakenAtItsWord() {
    let (id, records) = adopted()
    let record = records.first { $0.id == id }

    #expect(record?.name == "Third Base")
    #expect(record?.nameOrigin == .advertised)
    #expect(record?.lastKnownCNAME == cname)
  }

  @Test func aCameraWithNoNameGetsTheNextDefaultAndIsNotFollowed() {
    let (id, records) = adopted(name: nil)
    let record = records.first { $0.id == id }

    #expect(record?.name == "Camera 1")
    // Nothing to follow, so the first name the operator types must stick.
    #expect(record?.nameOrigin == .operatorAssigned)
    #expect(record?.advertisedName == nil)
    #expect(record?.lastKnownCNAME == cname)
  }

  @Test func renamingOnTheCameraRenamesItHere() {
    var (id, records) = adopted()
    CameraIdentityRules.apply(StreamAdvertisement(cname: cname, name: "First Base"), to: id, in: &records)

    #expect(records.first?.name == "First Base")
    #expect(records.first?.nameOrigin == .advertised)
  }

  @Test func theOperatorOutranksTheCamera() {
    var (id, records) = adopted()
    CameraIdentityRules.rename(id, to: "Left Field", in: &records)
    CameraIdentityRules.apply(StreamAdvertisement(cname: cname, name: "First Base"), to: id, in: &records)

    #expect(records.first?.name == "Left Field")
    #expect(records.first?.nameOrigin == .operatorAssigned)
    // Still remembered, so the UI can offer to go back to it.
    #expect(records.first?.advertisedName == "First Base")
  }

  @Test func theOperatorCanHandControlBack() {
    var (id, records) = adopted()
    CameraIdentityRules.rename(id, to: "Left Field", in: &records)
    CameraIdentityRules.apply(StreamAdvertisement(cname: cname, name: "First Base"), to: id, in: &records)

    CameraIdentityRules.followCamera(id, in: &records)

    // Adopted at once rather than at the next advertisement, so the menu item visibly does something.
    #expect(records.first?.name == "First Base")
    #expect(records.first?.nameOrigin == .advertised)
  }

  @Test func anOperatorNamedCameraStillGetsItsIdentifierRecorded() {
    var (id, records) = adopted(name: nil)
    CameraIdentityRules.rename(id, to: "Left Field", in: &records)
    CameraIdentityRules.apply(StreamAdvertisement(cname: "moved@gs-cameraman", name: nil), to: id, in: &records)

    // Identity is not a naming preference: an operator-named camera must still be findable.
    #expect(records.first?.lastKnownCNAME == "moved@gs-cameraman")
    #expect(records.first?.name == "Left Field")
  }

  @Test func twoCamerasClaimingOneNameStayDistinguishable() {
    var records: [CameraRecord] = []
    CameraIdentityRules.makeRecord(
      adopting: StreamAdvertisement(cname: "a@x", name: "Third Base"),
      host: "10.0.0.4", now: now, in: &records
    )
    CameraIdentityRules.makeRecord(
      adopting: StreamAdvertisement(cname: "b@x", name: "Third Base"),
      host: "10.0.0.5", now: now, in: &records
    )

    #expect(records.map(\.name) == [ "Third Base", "Third Base 2" ])
  }

  // MARK: - Binding

  @Test func theIdentifierBeatsTheAddressWhenTheLeaseMoved() {
    var records: [CameraRecord] = []
    let moved = CameraIdentityRules.makeRecord(
      adopting: StreamAdvertisement(cname: cname, name: "Third Base"),
      host: "10.0.0.4", now: now, in: &records
    )

    // The camera came back on a different address, and something else took its old one.
    let itsNewAddress = CameraEndpoint(host: "10.0.0.9")
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ CameraEndpoint(host: "10.0.0.4"), itsNewAddress ],
      records: records,
      streamAdvertisements: [ itsNewAddress: StreamAdvertisement(cname: cname, name: "Third Base") ]
    )

    let binding = bindings.first { $0.endpoint == itsNewAddress }
    #expect(binding?.cameraID == moved)
    #expect(binding?.origin == .autoByCNAME)
    // Its record was claimed by the identifier, so the address it used to hold binds to nothing.
    #expect(bindings.first { $0.endpoint.host == "10.0.0.4" }?.cameraID == nil)
  }

  @Test func aCameraThatSaysNothingStaysUnbound() {
    var records: [CameraRecord] = []
    CameraIdentityRules.makeRecord(named: "Third Base", host: "10.0.0.4", now: now, in: &records)

    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ CameraEndpoint(host: "10.0.0.4") ],
      records: records
    )

    // IP is not identity. Cameraman has to present a CNAME or the tile stays empty.
    #expect(bindings.first?.cameraID == nil)
    #expect(bindings.first?.origin == .unbound)
  }

  @Test func aManualCorrectionSurvivesTheCameraIdentifyingItself() {
    var records: [CameraRecord] = []
    let wrong = CameraIdentityRules.makeRecord(
      adopting: StreamAdvertisement(cname: cname, name: "Third Base"),
      host: "10.0.0.4", now: now, in: &records
    )
    let chosen = CameraIdentityRules.makeRecord(named: "Left Field", host: "10.0.0.9", now: now, in: &records)

    let endpoint = CameraEndpoint(host: "10.0.0.4")
    var bindings = [ CameraBinding(endpoint: endpoint, cameraID: chosen, origin: .manual) ]
    bindings = CameraIdentityRules.reconcile(
      bindings: bindings,
      endpoints: [ endpoint ],
      records: records,
      streamAdvertisements: [ endpoint: StreamAdvertisement(cname: cname, name: "Third Base") ]
    )

    // The operator has already looked at the screen and disagreed; a rediscovery seconds later must
    // not overrule that, however confidently the camera names itself.
    #expect(bindings.first?.cameraID == chosen)
    #expect(bindings.first?.origin == .manual)
    #expect(bindings.first?.cameraID != wrong)
  }

  @Test func rediscoveryKeepsFollowingTheIdentifier() {
    var records: [CameraRecord] = []
    let id = CameraIdentityRules.makeRecord(
      adopting: StreamAdvertisement(cname: cname, name: "Third Base"),
      host: "10.0.0.4", now: now, in: &records
    )

    let moved = CameraEndpoint(host: "10.0.0.9")
    let bindings = CameraIdentityRules.reconcile(
      bindings: [ CameraBinding(endpoint: CameraEndpoint(host: "10.0.0.4"), cameraID: id, origin: .autoByCNAME) ],
      endpoints: [ moved ],
      records: records,
      streamAdvertisements: [ moved: StreamAdvertisement(cname: cname, name: "Third Base") ]
    )

    #expect(bindings.count == 1)
    #expect(bindings.first?.cameraID == id)
    #expect(bindings.first?.origin == .autoByCNAME)
  }

  // MARK: - The cache written before any of this existed

  @Test func aCacheFromBeforeIdentityStillLoads() throws {
    // Exactly the shape the shipped build persists: no nameOrigin, no advertisedName, no cname.
    let legacy = """
      [{"id":"3F2504E0-4F89-11D3-9A0C-0305E82C3301","name":"Third Base",
        "lastKnownHost":"10.0.0.4","lastSeenAt":745558800}]
      """

    let decoder = JSONDecoder()
    let records = try decoder.decode([CameraRecord].self, from: Data(legacy.utf8))

    #expect(records.count == 1)
    #expect(records.first?.name == "Third Base")
    // A camera the operator already named must not start following whatever appears on that address.
    #expect(records.first?.nameOrigin == .operatorAssigned)
    #expect(records.first?.lastKnownCNAME == nil)
  }
}
