import Foundation
import DirectorCore
import DirectorSources
import Testing

/// The whole answer to "these cameras have no unique identifier on the wire". None of it needs a
/// camera, a network or a simulator.
@Suite("Camera identity")
struct CameraIdentityTests {
  private let epoch = Date(timeIntervalSince1970: 1_800_000_000)

  private func endpoint(_ host: String) -> CameraEndpoint {
    CameraEndpoint(host: host)
  }

  private func record(
    _ name: String,
    host: String,
    secondsAfterEpoch: TimeInterval = 0
  ) -> CameraRecord {
    CameraRecord(
      name: name,
      lastKnownHost: host,
      lastSeenAt: epoch.addingTimeInterval(secondsAfterEpoch)
    )
  }

  // MARK: - Automatic binding

  @Test("A camera returning on the address it last used keeps its name without being asked")
  func autoBindsByHost() {
    let records = [ record("Third Base", host: "10.10.7.148") ]
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148") ],
      records: records
    )

    #expect(bindings.count == 1)
    #expect(bindings[0].cameraID == records[0].id)
    #expect(bindings[0].origin == .autoByHost)
  }

  @Test("An address no cached camera has used stays unbound rather than guessing")
  func unknownHostStaysUnbound() {
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.99") ],
      records: [ record("Third Base", host: "10.10.7.148") ]
    )

    #expect(bindings[0].cameraID == nil)
    #expect(bindings[0].origin == .unbound)
  }

  @Test("When two cameras claim one address the most recently seen wins and the other waits")
  func duplicateHostClaimsResolveByRecency() {
    let stale = record("First Base", host: "10.10.7.148", secondsAfterEpoch: 0)
    let fresh = record("Third Base", host: "10.10.7.148", secondsAfterEpoch: 60)

    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148") ],
      records: [ stale, fresh ]
    )

    #expect(bindings.count == 1)
    #expect(bindings[0].cameraID == fresh.id)
  }

  @Test("One camera cannot occupy two endpoints at once")
  func aRecordBindsToAtMostOneEndpoint() {
    // Both endpoints last saw the same camera, which is only possible after address churn.
    let single = record("Third Base", host: "10.10.7.148")
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ CameraEndpoint(host: "10.10.7.148", port: 554), CameraEndpoint(host: "10.10.7.148", port: 8554) ],
      records: [ single ]
    )

    #expect(bindings.filter(\.isBound).count == 1)
  }

  @Test("Rediscovery does not reshuffle tiles")
  func autoBindIsDeterministic() {
    let records = [
      record("Third Base", host: "10.10.7.148"),
      record("First Base", host: "10.10.7.225")
    ]
    let forwards = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148"), endpoint("10.10.7.225") ],
      records: records
    )
    let backwards = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.225"), endpoint("10.10.7.148") ],
      records: records
    )

    #expect(forwards == backwards)
  }

  // MARK: - Manual binding

  @Test("Naming an unnamed camera takes it from whichever endpoint held it")
  func manualBindSteals() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    var bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148"), endpoint("10.10.7.225") ],
      records: records
    )

    CameraIdentityRules.bind(
      endpoint: endpoint("10.10.7.225"),
      to: records[0].id,
      in: &bindings,
      records: &records,
      now: epoch
    )

    let stolenFrom = bindings.first { $0.endpoint.host == "10.10.7.148" }
    let now = bindings.first { $0.endpoint.host == "10.10.7.225" }
    #expect(stolenFrom?.cameraID == nil)
    #expect(stolenFrom?.origin == .unbound)
    #expect(now?.cameraID == records[0].id)
    #expect(now?.origin == .manual)
  }

  @Test("Two cameras that exchanged addresses are fixed by correcting either one")
  func manualBindSwapsWhenBothHeld() {
    // The leases swapped overnight, so both cameras auto-bound to the wrong address.
    var records = [
      record("Third Base", host: "10.10.7.148"),
      record("First Base", host: "10.10.7.225")
    ]
    let thirdBase = records[0].id
    let firstBase = records[1].id
    var bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148"), endpoint("10.10.7.225") ],
      records: records
    )

    CameraIdentityRules.bind(
      endpoint: endpoint("10.10.7.225"),
      to: thirdBase,
      in: &bindings,
      records: &records,
      now: epoch
    )

    let at225 = bindings.first { $0.endpoint.host == "10.10.7.225" }
    let at148 = bindings.first { $0.endpoint.host == "10.10.7.148" }
    #expect(at225?.cameraID == thirdBase)
    #expect(at148?.cameraID == firstBase)
    #expect(at148?.origin == .manual)
  }

  @Test("Binding records the address so the next launch matches it automatically")
  func bindingUpdatesTheCache() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    var bindings: [CameraBinding] = []
    let later = epoch.addingTimeInterval(3600)

    CameraIdentityRules.bind(
      endpoint: endpoint("10.10.7.225"),
      to: records[0].id,
      in: &bindings,
      records: &records,
      now: later
    )

    #expect(records[0].lastKnownHost == "10.10.7.225")
    #expect(records[0].lastSeenAt == later)
  }

  @Test("An operator's pairing survives rediscovery even when addresses disagree with it")
  func reconcileKeepsManualBindings() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    var bindings: [CameraBinding] = []
    CameraIdentityRules.bind(
      endpoint: endpoint("10.10.7.225"),
      to: records[0].id,
      in: &bindings,
      records: &records,
      now: epoch
    )
    // Put the cache back to disagreeing with the operator.
    records[0].lastKnownHost = "10.10.7.148"

    let reconciled = CameraIdentityRules.reconcile(
      bindings: bindings,
      endpoints: [ endpoint("10.10.7.148"), endpoint("10.10.7.225") ],
      records: records
    )

    #expect(reconciled.first { $0.endpoint.host == "10.10.7.225" }?.cameraID == records[0].id)
    #expect(reconciled.first { $0.endpoint.host == "10.10.7.148" }?.cameraID == nil)
  }

  @Test("An endpoint that stopped answering drops out of the bindings")
  func reconcileDropsVanishedEndpoints() {
    let records = [ record("Third Base", host: "10.10.7.148") ]
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148"), endpoint("10.10.7.225") ],
      records: records
    )

    let reconciled = CameraIdentityRules.reconcile(
      bindings: bindings,
      endpoints: [ endpoint("10.10.7.148") ],
      records: records
    )

    #expect(reconciled.count == 1)
    #expect(reconciled[0].endpoint.host == "10.10.7.148")
  }

  // MARK: - Names

  @Test("Duplicate names are numbered, because the dropdown exists to tell cameras apart")
  func namesAreUnique() {
    var records: [CameraRecord] = []
    CameraIdentityRules.makeRecord(named: "Third Base", host: "a", now: epoch, in: &records)
    CameraIdentityRules.makeRecord(named: "Third Base", host: "b", now: epoch, in: &records)
    // Collisions are found case-insensitively, but the operator's own capitalisation is kept.
    CameraIdentityRules.makeRecord(named: "third base", host: "c", now: epoch, in: &records)

    #expect(records.map(\.name) == [ "Third Base", "Third Base 2", "third base 3" ])
  }

  @Test("Surrounding whitespace is not a way to have two cameras with the same name")
  func namesAreTrimmedBeforeComparison() {
    var records = [ record("Third Base", host: "a") ]
    CameraIdentityRules.makeRecord(named: "  Third Base  ", host: "b", now: epoch, in: &records)

    #expect(records[1].name == "Third Base 2")
  }

  @Test("An empty name still produces something selectable rather than a blank row")
  func emptyNameFallsBackToThePrefix() {
    #expect(CameraIdentityRules.uniqueName("   ", in: []) == "Camera")
  }

  @Test("Default names reuse the lowest free number after a camera is forgotten")
  func defaultNameUsesLowestFreeNumber() {
    var records: [CameraRecord] = []
    CameraIdentityRules.makeRecord(
      named: CameraIdentityRules.nextDefaultName(in: records), host: "a", now: epoch, in: &records
    )
    CameraIdentityRules.makeRecord(
      named: CameraIdentityRules.nextDefaultName(in: records), host: "b", now: epoch, in: &records
    )
    #expect(records.map(\.name) == [ "Camera 1", "Camera 2" ])

    var bindings: [CameraBinding] = []
    CameraIdentityRules.forget(records[0].id, from: &records, bindings: &bindings)

    #expect(CameraIdentityRules.nextDefaultName(in: records) == "Camera 1")
  }

  @Test("Renaming a camera to its own name does not number it")
  func renameIgnoresItself() {
    var records = [ record("Third Base", host: "a") ]
    CameraIdentityRules.rename(records[0].id, to: "Third Base", in: &records)

    #expect(records[0].name == "Third Base")
  }

  @Test("A rename keeps the identifier, so the archive does not fork")
  func renameKeepsTheIdentifier() {
    var records = [ record("Cam 2", host: "a") ]
    let id = records[0].id
    CameraIdentityRules.rename(id, to: "Third Base", in: &records)

    #expect(records[0].id == id)
    #expect(records[0].name == "Third Base")
  }

  // MARK: - Forgetting

  @Test("Forgetting a camera also frees the endpoint that was holding it")
  func forgetUnbinds() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    var bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148") ],
      records: records
    )

    CameraIdentityRules.forget(records[0].id, from: &records, bindings: &bindings)

    #expect(records.isEmpty)
    #expect(bindings[0].cameraID == nil)
    #expect(bindings[0].origin == .unbound)
  }

  @Test("Forgetting a camera lets the next advertisement adopt it again under the NearStream name")
  func forgetThenAdvertisementReadopts() {
    var records: [CameraRecord] = []
    let advertisement = CameraAdvertisement(
      host: "10.10.7.148",
      advertisedName: "00D9D 3rd",
      modelName: "VM33_00D9D"
    )
    CameraIdentityRules.applyAdvertisements([ advertisement ], to: &records, now: epoch)
    var bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148") ],
      records: records,
      advertisements: [ "10.10.7.148": advertisement ]
    )
    CameraIdentityRules.rename(records[0].id, to: "Third Base", in: &records)
    CameraIdentityRules.forget(records[0].id, from: &records, bindings: &bindings)

    CameraIdentityRules.applyAdvertisements([ advertisement ], to: &records, now: epoch)
    bindings = CameraIdentityRules.reconcile(
      bindings: bindings,
      endpoints: [ endpoint("10.10.7.148") ],
      records: records,
      advertisements: [ "10.10.7.148": advertisement ]
    )

    #expect(records.count == 1)
    #expect(records[0].name == "00D9D 3rd")
    #expect(bindings[0].cameraID == records[0].id)
    #expect(bindings[0].origin == .autoByIdentity)
  }

  @Test("A record that already has a TXT unique id stays identity-bound when Bonjour is quiet")
  func hardwareRecordMatchedByHostIsIdentity() {
    let records = [
      CameraRecord(
        name: "Third Base",
        lastKnownHost: "10.10.7.148",
        lastSeenAt: epoch,
        hardwareID: "model:VM33_00D9D"
      )
    ]
    let bindings = CameraIdentityRules.reconcile(
      bindings: [],
      endpoints: [ endpoint("10.10.7.148") ],
      records: records,
      advertisements: [:]
    )

    #expect(bindings[0].cameraID == records[0].id)
    #expect(bindings[0].origin == .autoByIdentity)
  }

  // MARK: - The pipeline key

  @Test("A bound camera keys the archive by identity, not by address")
  func sourceIDComesFromTheRecord() {
    let records = [ record("Third Base", host: "10.10.7.148") ]
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148") ],
      records: records
    )

    #expect(CameraIdentityRules.sourceID(for: bindings[0]).rawValue == records[0].id.uuidString)
  }

  @Test("An unnamed camera gets a provisional key that cannot collide with a real one")
  func unboundSourceIDIsProvisional() {
    let binding = CameraBinding(endpoint: endpoint("10.10.7.99"))

    #expect(CameraIdentityRules.sourceID(for: binding).rawValue == "camera-10.10.7.99")
  }

  @Test("A camera keeps its key across an address change, so the archive stays continuous")
  func sourceIDSurvivesAnAddressChange() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    let before = CameraIdentityRules.sourceID(
      for: CameraIdentityRules.autoBind(endpoints: [ endpoint("10.10.7.148") ], records: records)[0]
    )

    var bindings: [CameraBinding] = []
    CameraIdentityRules.bind(
      endpoint: endpoint("10.10.7.201"),
      to: records[0].id,
      in: &bindings,
      records: &records,
      now: epoch
    )

    #expect(CameraIdentityRules.sourceID(for: bindings[0]) == before)
  }

  // MARK: - Recovering a camera that moved

  @Test("A camera that changed address mid-game recovers onto the only free endpoint")
  func reresolveTakesTheOnlyCandidate() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    var bindings = [ CameraBinding(endpoint: endpoint("10.10.7.201")) ]

    let outcome = CameraIdentityRules.reresolve(
      records[0].id, in: &bindings, records: &records, now: epoch
    )

    #expect(outcome == .rebound(endpoint("10.10.7.201")))
    #expect(bindings[0].cameraID == records[0].id)
    #expect(records[0].lastKnownHost == "10.10.7.201")
  }

  @Test("With two free endpoints it asks rather than risking the wrong camera on air")
  func reresolveRefusesToGuess() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    var bindings = [
      CameraBinding(endpoint: endpoint("10.10.7.201")),
      CameraBinding(endpoint: endpoint("10.10.7.202"))
    ]

    let outcome = CameraIdentityRules.reresolve(
      records[0].id, in: &bindings, records: &records, now: epoch
    )

    #expect(outcome == .ambiguous(candidates: [ endpoint("10.10.7.201"), endpoint("10.10.7.202") ]))
    #expect(bindings.allSatisfy { !$0.isBound })
  }

  @Test("Nothing free means nothing to report but the absence")
  func reresolveWithNoCandidate() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    var bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148") ],
      records: records
    )

    let outcome = CameraIdentityRules.reresolve(
      records[0].id, in: &bindings, records: &records, now: epoch
    )

    #expect(outcome == .noCandidate)
  }

  // MARK: - Persistence

  @Test("The cache round-trips, because a name typed once must survive a relaunch")
  func recordsRoundTripThroughTheStore() throws {
    let defaults = try #require(UserDefaults(suiteName: "co.gamestation.director.tests.cameras"))
    defaults.removePersistentDomain(forName: "co.gamestation.director.tests.cameras")
    let store = CameraRecordStore(store: ConfigStore(defaults: defaults))

    let records = [
      record("Third Base", host: "10.10.7.148"),
      record("First Base", host: "10.10.7.225", secondsAfterEpoch: 30)
    ]
    store.save(records)

    #expect(store.load() == records)

    store.clear()
    #expect(store.load().isEmpty)
  }

  // MARK: - TXT unique ids

  @Test("modelname is the unique id when both TXT keys are present")
  func modelNameBeatsWLANMAC() {
    let advertisement = CameraAdvertisement.parseTXT(
      [ "modelname": "VM33_00D9D", "wlanmac": "a4:e8:8d:bd:27:d4", "busy": "no" ],
      instanceName: "00D9D 3rd",
      host: "10.10.7.148"
    )
    #expect(advertisement.uniqueID == "model:VM33_00D9D")
    #expect(advertisement.advertisedName == "00D9D 3rd")
    #expect(!advertisement.isBusy)
  }

  @Test("wlanmac from TXT is the unique id when modelname is missing")
  func wlanMACIsTheFallbackUniqueID() {
    let advertisement = CameraAdvertisement.parseTXT(
      [ "wlanmac": "A4E88DBD27D4" ],
      instanceName: "00D9D 3rd",
      host: "10.10.7.148"
    )
    #expect(advertisement.uniqueID == "mac:a4:e8:8d:bd:27:d4")
  }

  @Test("TXT ip= is the host when the closed SRV port cannot be connected")
  func txtIPIsAUsableHost() {
    let fields = [
      "modelname": "VM33_010D2",
      "ip": "10.10.8.201",
      "wlanmac": "a4:e8:8d:bd:2e:ce"
    ]
    #expect(CameraAdvertisement.ipv4Host(fromTXT: fields) == "10.10.8.201")
    #expect(CameraAdvertisement.resolvedHost(txtFields: fields) == "10.10.8.201")
    #expect(
      CameraAdvertisement.resolvedHost(txtFields: fields, pathIPv4: "10.10.8.199") == "10.10.8.199"
    )
  }

  @Test("A garbage TXT ip= is ignored so a later A-record can still supply the host")
  func garbageTXTIPIsIgnored() {
    #expect(CameraAdvertisement.ipv4Host(fromTXT: [ "ip": "not-an-address" ]) == nil)
    #expect(CameraAdvertisement.ipv4Host(fromTXT: [ "ip": "10.10.8" ]) == nil)
    #expect(CameraAdvertisement.resolvedHost(txtFields: [:], pathIPv4: "10.10.8.201") == "10.10.8.201")
  }

  @Test("A camera that moved keeps the name the operator already gave it")
  func hardwareIDSurvivesANewAddress() {
    var records = [
      CameraRecord(
        name: "Third Base",
        lastKnownHost: "10.10.7.148",
        lastSeenAt: epoch,
        hardwareID: "model:VM33_00D9D"
      )
    ]
    let advertisements = [
      CameraAdvertisement(
        host: "10.10.7.201",
        advertisedName: "00D9D 3rd",
        modelName: "VM33_00D9D"
      )
    ]

    CameraIdentityRules.applyAdvertisements(advertisements, to: &records, now: epoch)
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.201") ],
      records: records,
      advertisements: [ "10.10.7.201": advertisements[0] ]
    )

    #expect(records[0].name == "Third Base")
    #expect(records[0].lastKnownHost == "10.10.7.201")
    #expect(bindings[0].cameraID == records[0].id)
    #expect(bindings[0].origin == .autoByIdentity)
  }

  @Test("TXT identity beats a stale last-known host after a DHCP swap")
  func hardwareMatchBeatsStaleHost() {
    let third = CameraRecord(
      name: "Third Base",
      lastKnownHost: "10.10.7.148",
      lastSeenAt: epoch,
      hardwareID: "model:VM33_00D9D"
    )
    let first = CameraRecord(
      name: "First Base",
      lastKnownHost: "10.10.7.225",
      lastSeenAt: epoch,
      hardwareID: "model:VM33_010D2"
    )
    var records = [ third, first ]
    let advertisements = [
      "10.10.7.148": CameraAdvertisement(
        host: "10.10.7.148",
        advertisedName: "010D2 1st",
        modelName: "VM33_010D2"
      ),
      "10.10.7.225": CameraAdvertisement(
        host: "10.10.7.225",
        advertisedName: "00D9D 3rd",
        modelName: "VM33_00D9D"
      )
    ]

    CameraIdentityRules.applyAdvertisements(Array(advertisements.values), to: &records, now: epoch)
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint("10.10.7.148"), endpoint("10.10.7.225") ],
      records: records,
      advertisements: advertisements
    )

    #expect(bindings.first { $0.endpoint.host == "10.10.7.148" }?.cameraID == first.id)
    #expect(bindings.first { $0.endpoint.host == "10.10.7.225" }?.cameraID == third.id)
  }

  @Test("A first-seen advertisement becomes a named record without the operator typing")
  func firstSightAdoptsTheAdvertisedName() {
    var records: [CameraRecord] = []
    CameraIdentityRules.applyAdvertisements(
      [
        CameraAdvertisement(
          host: "10.10.7.148",
          advertisedName: "00D9D 3rd",
          modelName: "VM33_00D9D"
        )
      ],
      to: &records,
      now: epoch
    )

    #expect(records.count == 1)
    #expect(records[0].name == "00D9D 3rd")
    #expect(records[0].hardwareID == "model:VM33_00D9D")
  }

  @Test("A legacy record at this address is stamped with the TXT unique id")
  func legacyHostRecordGainsHardwareID() {
    var records = [ record("Third Base", host: "10.10.7.148") ]
    CameraIdentityRules.applyAdvertisements(
      [
        CameraAdvertisement(
          host: "10.10.7.148",
          advertisedName: "00D9D 3rd",
          modelName: "VM33_00D9D"
        )
      ],
      to: &records,
      now: epoch
    )

    #expect(records.count == 1)
    #expect(records[0].name == "Third Base")
    #expect(records[0].hardwareID == "model:VM33_00D9D")
  }

  // MARK: - SDP / RTCP CNAME

  @Test("A camera that presents a CNAME is matched on it after it moves")
  func autoBindsByCNAMEAfterALeaseChange() {
    var records: [CameraRecord] = []
    let advertisement = StreamAdvertisement(cname: "3f2504e04f8911d3@gs-cameraman", name: "Third Base")
    let id = CameraIdentityRules.makeRecord(
      adopting: advertisement,
      host: "10.10.7.148",
      now: epoch,
      in: &records
    )
    let moved = endpoint("10.10.8.2")
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ moved ],
      records: records,
      streamAdvertisements: [ moved: advertisement ]
    )

    #expect(bindings[0].cameraID == id)
    #expect(bindings[0].origin == .autoByCNAME)
    #expect(records[0].name == "Third Base")
    #expect(records[0].nameOrigin == .advertised)
  }

  @Test("TXT unique id outranks a CNAME when both are present")
  func txtIdentityBeatsCNAME() {
    let txt = CameraAdvertisement(
      host: "10.10.7.148",
      advertisedName: "00D9D 3rd",
      modelName: "VM33_00D9D"
    )
    let records = [
      CameraRecord(
        name: "Third Base",
        lastKnownCNAME: "phone@example",
        lastKnownHost: "10.10.7.99",
        lastSeenAt: epoch,
        hardwareID: "model:VM33_00D9D"
      )
    ]
    let endpoint = endpoint("10.10.7.148")
    let bindings = CameraIdentityRules.autoBind(
      endpoints: [ endpoint ],
      records: records,
      advertisements: [ "10.10.7.148": txt ],
      streamAdvertisements: [ endpoint: StreamAdvertisement(cname: "phone@example", name: "iPhone") ]
    )

    #expect(bindings[0].origin == .autoByIdentity)
    #expect(bindings[0].cameraID == records[0].id)
  }

  @Test("An operator rename is not undone by a later advertisement")
  func operatorNameSurvivesStreamRename() {
    var records: [CameraRecord] = []
    let id = CameraIdentityRules.makeRecord(
      adopting: StreamAdvertisement(cname: "a@x", name: "Third Base"),
      host: "10.10.7.148",
      now: epoch,
      in: &records
    )
    CameraIdentityRules.rename(id, to: "Home", in: &records)
    CameraIdentityRules.apply(
      StreamAdvertisement(cname: "a@x", name: "First Base"),
      to: id,
      in: &records
    )

    #expect(records[0].name == "Home")
    #expect(records[0].nameOrigin == .operatorAssigned)
    #expect(records[0].advertisedName == "First Base")
    #expect(records[0].lastKnownCNAME == "a@x")
  }

  @Test("A cache written before identity fields existed still loads")
  func legacyRecordDecodesWithoutIdentityKeys() throws {
    let payload = """
    [{"id":"3F2504E0-4F89-11D3-9A0C-0305E82C3301","name":"Third Base",\
    "lastKnownHost":"10.10.7.148","lastSeenAt":-978307200}]
    """
    let records = try JSONDecoder().decode(
      [CameraRecord].self,
      from: Data(payload.utf8)
    )

    #expect(records[0].name == "Third Base")
    #expect(records[0].nameOrigin == .operatorAssigned)
    #expect(records[0].lastKnownCNAME == nil)
    #expect(records[0].hardwareID == nil)
  }
}
