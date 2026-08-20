import Foundation
import ProducerCore

/// What discovery finds on the network this instant. The host is where RTSP answers today, not
/// who the camera is: that comes from `_awx_service._tcp` TXT when the camera publishes it.
public struct CameraEndpoint: Hashable, Sendable, Codable {
  public let host: String
  public let port: Int
  public let path: String

  public init(host: String, port: Int = 554, path: String = "/live/mainstream") {
    self.host = host
    self.port = port
    self.path = path
  }

  public var url: String { "rtsp://\(host):\(port)\(path)" }

  /// `rtsp://192.168.7.148:554/live/mainstream` back into its parts. Lives here rather than in the
  /// transport package so the UI can read an endpoint off a discovered source without importing it.
  public init?(address: String?, fallbackPath: String = "/live/mainstream") {
    guard
      let address,
      let components = URLComponents(string: address),
      let host = components.host,
      !host.isEmpty
    else { return nil }
    self.init(
      host: host,
      port: components.port ?? 554,
      path: components.path.isEmpty ? fallbackPath : components.path
    )
  }
}

/// What the operator named, and what persists across launches. The durable entity.
///
/// Keyed by a UUID rather than by the name, because the name is a label the operator edits
/// mid-game. If the name were the key, every rename would orphan that camera's archive segments
/// and telemetry history.
public struct CameraRecord: Hashable, Sendable, Codable, Identifiable {
  public let id: UUID
  public var name: String
  /// Last address this camera answered on. A hint for auto-binding when no TXT unique id is known.
  public var lastKnownHost: String
  /// Stable id from `_awx_service._tcp` TXT: `modelname` first, else `wlanmac`. Nil for cameras
  /// named before that browse existed, and for anything that does not advertise.
  public var hardwareID: String?
  public var lastSeenAt: Date
  /// The smoothing buffer this camera settled on last time it was used. A camera's jitter comes
  /// from its own encoder settings, so it is much the same game to game, and remembering it means
  /// the picture is smooth from the first second rather than from the tenth.
  public var playoutMilliseconds: Double?

  public init(
    id: UUID = UUID(),
    name: String,
    lastKnownHost: String,
    lastSeenAt: Date,
    hardwareID: String? = nil,
    playoutMilliseconds: Double? = nil
  ) {
    self.id = id
    self.name = name
    self.lastKnownHost = lastKnownHost
    self.lastSeenAt = lastSeenAt
    self.hardwareID = hardwareID
    self.playoutMilliseconds = playoutMilliseconds
  }
}

/// This session's association between an endpoint and a record.
public struct CameraBinding: Hashable, Sendable {
  public enum Origin: String, Hashable, Sendable {
    /// Matched because `_awx_service._tcp` TXT identified this camera (modelname, else wlanmac).
    case autoByIdentity
    /// Matched automatically because the endpoint's address is the one this camera last used.
    case autoByHost
    /// The operator chose this pairing, so automatic matching must not override it.
    case manual
    case unbound
  }

  public let endpoint: CameraEndpoint
  public var cameraID: UUID?
  public var origin: Origin

  public init(endpoint: CameraEndpoint, cameraID: UUID? = nil, origin: Origin = .unbound) {
    self.endpoint = endpoint
    self.cameraID = cameraID
    self.origin = origin
  }

  public var isBound: Bool { cameraID != nil }
}

/// Binding, naming and cache rules. Pure functions over values, with no networking and no UI, so
/// every rule below is testable without a device.
public enum CameraIdentityRules {
  /// Name given to a camera the operator puts on a tile without naming it first.
  public static let defaultNamePrefix = "Camera"

  // MARK: - Deriving the pipeline key

  /// `SourceID` is the key the DVR, proxy store, archive index and telemetry all use. Deriving it
  /// from the record rather than the address is what lets an archive survive a DHCP change and an
  /// app restart.
  public static func sourceID(for binding: CameraBinding) -> SourceID {
    guard let cameraID = binding.cameraID else { return SourceID("camera-\(binding.endpoint.host)") }
    return SourceID(cameraID.uuidString)
  }

  // MARK: - Automatic binding

  /// Pairs endpoints with records. TXT unique ids outrank last-known address, so a DHCP swap does
  /// not silently put the wrong camera on a tile.
  public static func autoBind(
    endpoints: [CameraEndpoint],
    records: [CameraRecord],
    advertisements: [String: CameraAdvertisement] = [:]
  ) -> [CameraBinding] {
    var claimed: Set<UUID> = []
    return sorted(endpoints).map { endpoint in
      guard let match = match(
        endpoint,
        records: records,
        advertisements: advertisements,
        excluding: claimed
      ) else {
        return CameraBinding(endpoint: endpoint)
      }
      claimed.insert(match.record.id)
      return CameraBinding(endpoint: endpoint, cameraID: match.record.id, origin: match.origin)
    }
  }

  /// Folds a fresh discovery result into the bindings this session already has.
  ///
  /// Operator choices outrank address matching, so a `.manual` binding survives a rediscovery even
  /// when the addresses would now suggest otherwise. Endpoints that stopped answering are dropped;
  /// their records stay in the cache so the camera can come back on a different address.
  public static func reconcile(
    bindings: [CameraBinding],
    endpoints: [CameraEndpoint],
    records: [CameraRecord],
    advertisements: [String: CameraAdvertisement] = [:]
  ) -> [CameraBinding] {
    let live = Set(endpoints)
    var claimed: Set<UUID> = []
    var kept: [CameraEndpoint: CameraBinding] = [:]

    for binding in bindings where live.contains(binding.endpoint) {
      guard
        binding.origin == .manual,
        let cameraID = binding.cameraID,
        records.contains(where: { $0.id == cameraID }),
        !claimed.contains(cameraID)
      else { continue }
      claimed.insert(cameraID)
      kept[binding.endpoint] = binding
    }

    return sorted(endpoints).map { endpoint in
      if let binding = kept[endpoint] { return binding }
      guard let match = match(
        endpoint,
        records: records,
        advertisements: advertisements,
        excluding: claimed
      ) else {
        return CameraBinding(endpoint: endpoint)
      }
      claimed.insert(match.record.id)
      return CameraBinding(endpoint: endpoint, cameraID: match.record.id, origin: match.origin)
    }
  }

  // MARK: - Manual binding

  /// Assigns a camera to an endpoint on the operator's instruction.
  ///
  /// Two cases matter and both are reachable from the same dropdown. If the camera is currently on
  /// another endpoint and this endpoint holds nothing, the other endpoint gives it up. If both hold
  /// a camera, the two swap — which is the exact remedy for two cameras having exchanged leases,
  /// the most likely real mis-binding.
  public static func bind(
    endpoint: CameraEndpoint,
    to cameraID: UUID,
    in bindings: inout [CameraBinding],
    records: inout [CameraRecord],
    now: Date
  ) {
    let target = index(of: endpoint, in: &bindings)
    let displaced = bindings[target].cameraID
    let previousHolder = bindings.indices.first { $0 != target && bindings[$0].cameraID == cameraID }

    bindings[target].cameraID = cameraID
    bindings[target].origin = .manual
    touch(cameraID, host: endpoint.host, at: now, in: &records)

    guard let previousHolder else { return }
    if let displaced {
      bindings[previousHolder].cameraID = displaced
      bindings[previousHolder].origin = .manual
      touch(displaced, host: bindings[previousHolder].endpoint.host, at: now, in: &records)
    } else {
      bindings[previousHolder].cameraID = nil
      bindings[previousHolder].origin = .unbound
    }
  }

  public static func unbind(endpoint: CameraEndpoint, in bindings: inout [CameraBinding]) {
    guard let position = bindings.firstIndex(where: { $0.endpoint == endpoint }) else { return }
    bindings[position].cameraID = nil
    bindings[position].origin = .unbound
  }

  // MARK: - The record cache

  /// Creates a camera the operator has named, or is about to name by putting it on a tile.
  @discardableResult
  public static func makeRecord(
    named name: String,
    host: String,
    now: Date,
    hardwareID: String? = nil,
    in records: inout [CameraRecord]
  ) -> UUID {
    let record = CameraRecord(
      name: uniqueName(name, in: records),
      lastKnownHost: host,
      lastSeenAt: now,
      hardwareID: hardwareID
    )
    records.append(record)
    return record.id
  }

  /// Folds Bonjour identity into the cache. Existing names are never overwritten: the advertised
  /// name is only the default for a camera we have not seen before.
  public static func applyAdvertisements(
    _ advertisements: [CameraAdvertisement],
    to records: inout [CameraRecord],
    now: Date
  ) {
    for advertisement in advertisements {
      guard let uniqueID = advertisement.uniqueID else { continue }
      if let position = records.firstIndex(where: { $0.hardwareID == uniqueID }) {
        records[position].lastKnownHost = advertisement.host
        records[position].lastSeenAt = now
        continue
      }
      if let position = records.firstIndex(where: {
        $0.hardwareID == nil && $0.lastKnownHost == advertisement.host
      }) {
        records[position].hardwareID = uniqueID
        records[position].lastSeenAt = now
        continue
      }
      makeRecord(
        named: advertisement.advertisedName,
        host: advertisement.host,
        now: now,
        hardwareID: uniqueID,
        in: &records
      )
    }
  }

  /// Two cameras with the same name are indistinguishable in the dropdown that exists precisely to
  /// tell them apart, so collisions are numbered rather than rejected.
  public static func uniqueName(_ proposed: String, in records: [CameraRecord]) -> String {
    let trimmed = proposed.trimmingCharacters(in: .whitespacesAndNewlines)
    let base = trimmed.isEmpty ? defaultNamePrefix : trimmed
    let taken = Set(records.map { $0.name.lowercased() })
    guard taken.contains(base.lowercased()) else { return base }

    var suffix = 2
    while taken.contains("\(base) \(suffix)".lowercased()) { suffix += 1 }
    return "\(base) \(suffix)"
  }

  /// `Camera 1`, `Camera 2`, … reusing the lowest free number so a forgotten camera's name becomes
  /// available again rather than the count climbing forever.
  public static func nextDefaultName(in records: [CameraRecord]) -> String {
    let taken = Set(records.map { $0.name.lowercased() })
    var n = 1
    while taken.contains("\(defaultNamePrefix) \(n)".lowercased()) { n += 1 }
    return "\(defaultNamePrefix) \(n)"
  }

  public static func rename(
    _ cameraID: UUID,
    to name: String,
    in records: inout [CameraRecord]
  ) {
    guard let position = records.firstIndex(where: { $0.id == cameraID }) else { return }
    let others = records.filter { $0.id != cameraID }
    records[position].name = uniqueName(name, in: others)
  }

  /// Forgetting takes the bindings too. Leaving an endpoint pointing at a deleted record would put
  /// a tile behind a camera the cache no longer knows.
  public static func forget(
    _ cameraID: UUID,
    from records: inout [CameraRecord],
    bindings: inout [CameraBinding]
  ) {
    records.removeAll { $0.id == cameraID }
    for position in bindings.indices where bindings[position].cameraID == cameraID {
      bindings[position].cameraID = nil
      bindings[position].origin = .unbound
    }
  }

  // MARK: - Recovering a camera that moved

  public enum Reresolution: Equatable {
    /// Exactly one endpoint was free, so the camera was moved onto it without asking.
    case rebound(CameraEndpoint)
    /// Several endpoints were free; guessing here could put the wrong camera on a tile mid-game.
    case ambiguous(candidates: [CameraEndpoint])
    case noCandidate
  }

  /// Moves a camera whose address stopped answering onto a newly discovered one.
  ///
  /// Automatic only when the choice is forced. With two unclaimed endpoints there is no evidence
  /// for either, and silently picking one is how the wrong camera ends up on air.
  public static func reresolve(
    _ cameraID: UUID,
    in bindings: inout [CameraBinding],
    records: inout [CameraRecord],
    now: Date
  ) -> Reresolution {
    let free = bindings.filter { !$0.isBound }.map(\.endpoint)
    guard free.count == 1, let endpoint = free.first else {
      return free.isEmpty ? .noCandidate : .ambiguous(candidates: sorted(free))
    }
    bind(endpoint: endpoint, to: cameraID, in: &bindings, records: &records, now: now)
    return .rebound(endpoint)
  }

  // MARK: - Helpers

  private static func sorted(_ endpoints: [CameraEndpoint]) -> [CameraEndpoint] {
    endpoints.sorted {
      ($0.host, $0.port, $0.path) < ($1.host, $1.port, $1.path)
    }
  }

  /// TXT unique id first; last-known host only when the camera has never advertised one.
  private static func match(
    _ endpoint: CameraEndpoint,
    records: [CameraRecord],
    advertisements: [String: CameraAdvertisement],
    excluding claimed: Set<UUID>
  ) -> (record: CameraRecord, origin: CameraBinding.Origin)? {
    if let uniqueID = advertisements[endpoint.host]?.uniqueID,
       let record = records.first(where: { $0.hardwareID == uniqueID && !claimed.contains($0.id) }) {
      return (record, .autoByIdentity)
    }
    guard let record = bestRecord(for: endpoint, in: records, excluding: claimed) else {
      return nil
    }
    // A record that already carries a TXT unique id stays identity-bound when Bonjour is quiet
    // for a moment. Matching still uses lastKnownHost, so a live advertisement remains the only
    // way to follow a camera that actually moved.
    return (record, record.hardwareID == nil ? .autoByHost : .autoByIdentity)
  }

  /// Most recently seen record for this address. Ties break on the identifier so a rediscovery
  /// cannot reshuffle tiles for no reason.
  private static func bestRecord(
    for endpoint: CameraEndpoint,
    in records: [CameraRecord],
    excluding claimed: Set<UUID>
  ) -> CameraRecord? {
    records
      .filter { $0.lastKnownHost == endpoint.host && !claimed.contains($0.id) }
      .max {
        ($0.lastSeenAt, $0.id.uuidString) < ($1.lastSeenAt, $1.id.uuidString)
      }
  }

  private static func index(
    of endpoint: CameraEndpoint,
    in bindings: inout [CameraBinding]
  ) -> Int {
    if let position = bindings.firstIndex(where: { $0.endpoint == endpoint }) { return position }
    bindings.append(CameraBinding(endpoint: endpoint))
    return bindings.index(before: bindings.endIndex)
  }

  private static func touch(
    _ cameraID: UUID,
    host: String,
    at now: Date,
    in records: inout [CameraRecord]
  ) {
    guard let position = records.firstIndex(where: { $0.id == cameraID }) else { return }
    records[position].lastKnownHost = host
    records[position].lastSeenAt = now
  }
}

/// `UserDefaults` persistence for the named-camera cache.
public struct CameraRecordStore: Sendable {
  private static let key = "co.gamestation.producer.cameras"
  private let store: ConfigStore

  public init(store: ConfigStore = ConfigStore()) {
    self.store = store
  }

  public func load() -> [CameraRecord] {
    store.codableValue([CameraRecord].self, forKey: Self.key) ?? []
  }

  public func save(_ records: [CameraRecord]) {
    store.setCodableValue(records, forKey: Self.key)
  }

  public func clear() {
    store.removeValue(forKey: Self.key)
  }
}
