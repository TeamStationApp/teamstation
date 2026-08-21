import Foundation
import DirectorCore

/// Owns the named-camera cache and this session's bindings, and persists them.
///
/// It sits outside the UI because two very different callers need it: the source list, on the main
/// actor, and discovery, on a background task after every scan. Keeping the state here — behind a
/// lock, in one place — is what stops those two from disagreeing about which camera is which.
public final class CameraRegistry: @unchecked Sendable {
  private let store: CameraRecordStore
  private let lock = NSLock()
  private var cachedRecords: [CameraRecord]
  private var cachedBindings: [CameraBinding] = []
  /// Last non-empty `_awx_service._tcp` snapshot. A rename or forget must not wait on Bonjour:
  /// an empty browse update would otherwise demote every identity binding to address matching.
  private var lastAdvertisements: [CameraAdvertisement] = []
  /// What each endpoint last said about itself on SDP/RTCP. Session-only: an advertisement is a
  /// live claim, and a stale one would let a camera that has gone away keep its hold on a record.
  private var advertised: [CameraEndpoint: StreamAdvertisement] = [:]

  /// Shared by every camera's delay line: it holds them all to one delay and hands each the size it
  /// learned last time. It lives here because this is what already knows which camera is which
  /// across sessions.
  public let playout = PlayoutCoordinator()

  /// Below this a re-measured buffer is the same buffer, and writing it out would mean a store
  /// write every second for the whole game.
  private static let playoutSaveThreshold: Double = 25

  public init(store: CameraRecordStore = CameraRecordStore()) {
    self.store = store
    cachedRecords = store.load()
    for record in cachedRecords {
      playout.seed(record.playoutMilliseconds, for: SourceID(record.id.uuidString))
    }
  }

  /// Records what a camera's delay line settled on, so the next session starts there.
  public func rememberPlayout(_ milliseconds: Double, for sourceID: SourceID) {
    lock.lock()
    guard
      let position = cachedRecords.firstIndex(where: { $0.id.uuidString == sourceID.rawValue }),
      abs((cachedRecords[position].playoutMilliseconds ?? 0) - milliseconds) >= Self.playoutSaveThreshold
    else {
      lock.unlock()
      return
    }
    cachedRecords[position].playoutMilliseconds = milliseconds
    let records = cachedRecords
    lock.unlock()

    playout.seed(milliseconds, for: sourceID)
    store.save(records)
  }

  public var records: [CameraRecord] {
    lock.lock()
    defer { lock.unlock() }
    return cachedRecords
  }

  public var bindings: [CameraBinding] {
    lock.lock()
    defer { lock.unlock() }
    return cachedBindings
  }

  public func binding(for endpoint: CameraEndpoint) -> CameraBinding? {
    lock.lock()
    defer { lock.unlock() }
    return cachedBindings.first { $0.endpoint == endpoint }
  }

  /// The endpoint a camera is currently reachable at, if any.
  public func endpoint(for cameraID: UUID) -> CameraEndpoint? {
    lock.lock()
    defer { lock.unlock() }
    return cachedBindings.first { $0.cameraID == cameraID }?.endpoint
  }

  public func record(id: UUID) -> CameraRecord? {
    lock.lock()
    defer { lock.unlock() }
    return cachedRecords.first { $0.id == id }
  }

  /// Folds a fresh scan into the bindings and reports what each endpoint should be called.
  ///
  /// Operator choices survive here, so a rediscovery cannot undo a manual correction made seconds
  /// earlier — see `CameraIdentityRules.reconcile`. TXT advertisements create or reattach records
  /// before that, so a camera that moved keeps the name the operator already gave it.
  public func resolve(
    endpoints: [CameraEndpoint],
    advertisements: [CameraAdvertisement] = [],
    now: Date = Date()
  ) -> [CameraEndpoint: (id: SourceID, name: String)] {
    lock.lock()
    let ads = remembered(advertisements)
    CameraIdentityRules.applyAdvertisements(ads, to: &cachedRecords, now: now)
    CameraIdentityRules.applyStreamAdvertisements(advertised, to: &cachedRecords, now: now)
    let byHost = Dictionary(ads.map { ($0.host, $0) }, uniquingKeysWith: { _, latest in latest })
    advertised = advertised.filter { endpoints.contains($0.key) }
    cachedBindings = CameraIdentityRules.reconcile(
      bindings: cachedBindings,
      endpoints: endpoints,
      records: cachedRecords,
      advertisements: byHost,
      streamAdvertisements: advertised
    )

    // A camera that has just been matched to its record may have advertised a new name while the
    // binding was still being worked out, so the adoption happens after the match, not before it.
    for binding in cachedBindings {
      guard let cameraID = binding.cameraID, let claim = advertised[binding.endpoint] else { continue }
      CameraIdentityRules.apply(claim, to: cameraID, in: &cachedRecords)
    }

    let records = cachedRecords
    let bindings = cachedBindings
    lock.unlock()
    store.save(records)

    var result: [CameraEndpoint: (id: SourceID, name: String)] = [:]
    for binding in bindings {
      let name = binding.cameraID
        .flatMap { id in records.first { $0.id == id }?.name }
      result[binding.endpoint] = (
        id: CameraIdentityRules.sourceID(for: binding),
        name: name ?? binding.endpoint.host
      )
    }
    return result
  }

  /// Assigns a cached camera to an endpoint on the operator's instruction, swapping or stealing as
  /// the rules require.
  public func bind(endpoint: CameraEndpoint, to cameraID: UUID, now: Date = Date()) {
    lock.lock()
    CameraIdentityRules.bind(
      endpoint: endpoint,
      to: cameraID,
      in: &cachedBindings,
      records: &cachedRecords,
      now: now
    )
    let records = cachedRecords
    lock.unlock()

    store.save(records)
  }

  /// Names an endpoint the operator has not named, so putting an unnamed camera on a tile is never
  /// blocked by the naming step while still leaving the cache honest.
  @discardableResult
  public func adopt(endpoint: CameraEndpoint, name: String? = nil, now: Date = Date()) -> UUID {
    lock.lock()
    let proposed = name ?? CameraIdentityRules.nextDefaultName(in: cachedRecords)
    let hardwareID = lastAdvertisements.first { $0.host == endpoint.host }?.uniqueID
    let claim = advertised[endpoint]
    let id = CameraIdentityRules.makeRecord(
      named: proposed,
      host: endpoint.host,
      now: now,
      hardwareID: hardwareID,
      advertisedName: claim?.name,
      lastKnownCNAME: claim?.cname,
      in: &cachedRecords
    )
    CameraIdentityRules.bind(
      endpoint: endpoint,
      to: id,
      in: &cachedBindings,
      records: &cachedRecords,
      now: now
    )
    let records = cachedRecords
    lock.unlock()

    store.save(records)
    return id
  }

  public func rename(_ cameraID: UUID, to name: String) {
    lock.lock()
    CameraIdentityRules.rename(cameraID, to: name, in: &cachedRecords)
    let records = cachedRecords
    lock.unlock()

    store.save(records)
  }

  /// Puts a camera back under its own control, adopting the name it last advertised.
  public func followCamera(_ cameraID: UUID) {
    lock.lock()
    CameraIdentityRules.followCamera(cameraID, in: &cachedRecords)
    let records = cachedRecords
    lock.unlock()

    store.save(records)
  }

  /// Records what a camera said about itself, so the next `resolve` can match on the identifier
  /// and a camera being followed picks up a rename made on the phone.
  ///
  /// Kept for endpoints with no record too: a camera that introduces itself before the operator has
  /// named it must still be matchable by identifier once it is named.
  public func note(_ advertisement: StreamAdvertisement, from endpoint: CameraEndpoint) {
    guard !advertisement.isEmpty else { return }

    lock.lock()
    let merged = StreamAdvertisement(
      cname: advertisement.cname ?? advertised[endpoint]?.cname,
      name: advertisement.name ?? advertised[endpoint]?.name
    )
    if advertised[endpoint] == merged {
      lock.unlock()
      return
    }
    advertised[endpoint] = merged
    let cameraID = cachedBindings.first { $0.endpoint == endpoint }?.cameraID
    if let cameraID {
      CameraIdentityRules.apply(merged, to: cameraID, in: &cachedRecords)
    } else {
      CameraIdentityRules.applyStreamAdvertisements(
        [ endpoint: merged ],
        to: &cachedRecords,
        now: Date()
      )
    }
    let records = cachedRecords
    lock.unlock()

    store.save(records)
  }

  public func advertisement(for endpoint: CameraEndpoint) -> StreamAdvertisement? {
    lock.lock()
    defer { lock.unlock() }
    return advertised[endpoint]
  }

  public func forget(_ cameraID: UUID, now: Date = Date()) {
    lock.lock()
    CameraIdentityRules.forget(cameraID, from: &cachedRecords, bindings: &cachedBindings)
    CameraIdentityRules.applyAdvertisements(lastAdvertisements, to: &cachedRecords, now: now)
    let byHost = Dictionary(
      lastAdvertisements.map { ($0.host, $0) },
      uniquingKeysWith: { _, latest in latest }
    )
    cachedBindings = CameraIdentityRules.reconcile(
      bindings: cachedBindings,
      endpoints: cachedBindings.map(\.endpoint),
      records: cachedRecords,
      advertisements: byHost,
      streamAdvertisements: advertised
    )
    let records = cachedRecords
    lock.unlock()

    store.save(records)
  }

  /// Moves a camera whose address stopped answering onto a newly discovered one.
  @discardableResult
  public func reresolve(_ cameraID: UUID, now: Date = Date()) -> CameraIdentityRules.Reresolution {
    lock.lock()
    let outcome = CameraIdentityRules.reresolve(
      cameraID,
      in: &cachedBindings,
      records: &cachedRecords,
      now: now
    )
    let records = cachedRecords
    lock.unlock()

    store.save(records)
    return outcome
  }

  /// The same move, addressed the way the rest of the app knows a camera. A frame source only knows
  /// its `SourceID`, so this is the entry point when a tile reports its camera has gone quiet.
  @discardableResult
  public func reresolve(sourceID: SourceID, now: Date = Date()) -> CameraIdentityRules.Reresolution {
    lock.lock()
    let cameraID = cachedBindings
      .first { CameraIdentityRules.sourceID(for: $0) == sourceID }?
      .cameraID
    lock.unlock()

    guard let cameraID else { return .noCandidate }
    return reresolve(cameraID, now: now)
  }

  public func clear() {
    lock.lock()
    cachedRecords = []
    cachedBindings = []
    lastAdvertisements = []
    advertised = [:]
    lock.unlock()

    store.clear()
  }

  /// Incoming Bonjour snapshots are merged, and a unique id already learned is kept when the
  /// latest browse has the host but empty TXT. Replacing the snapshot would make Forget leave
  /// the row unnamed until the next full sweep.
  private func remembered(_ incoming: [CameraAdvertisement]) -> [CameraAdvertisement] {
    var byHost: [String: CameraAdvertisement] = Dictionary(
      lastAdvertisements.map { ($0.host, $0) },
      uniquingKeysWith: { _, latest in latest }
    )
    for advertisement in incoming {
      if advertisement.uniqueID != nil {
        byHost[advertisement.host] = advertisement
      } else if byHost[advertisement.host] == nil {
        byHost[advertisement.host] = advertisement
      }
    }
    lastAdvertisements = Array(byHost.values)
    return lastAdvertisements
  }
}
