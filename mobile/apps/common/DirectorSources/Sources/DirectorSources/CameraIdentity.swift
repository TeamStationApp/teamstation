import Foundation
import DirectorCore

/// What discovery finds on the network this instant. The host is where RTSP answers today, not
/// who the camera is: that comes from `_awx_service._tcp` TXT when the camera publishes it, or
/// from the SDP/RTCP `CNAME` when it does not.
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

  /// `rtsp://10.10.7.148:554/live/mainstream` back into its parts. Lives here rather than in the
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

/// What a camera says about itself, read from the SDP at `DESCRIBE` and from RTCP SDES while
/// streaming. Advisory: a camera can claim any name, and most claim nothing at all.
///
/// Distinct from `CameraAdvertisement`, which is the NearStream `_awx_service._tcp` TXT blob.
public struct StreamAdvertisement: Hashable, Sendable, Codable {
  /// RFC 3550 `CNAME`. Stable across address changes and app restarts, which is what makes it
  /// usable as an identity where the address is not.
  public let cname: String?
  public let name: String?

  public init(cname: String? = nil, name: String? = nil) {
    self.cname = cname
    self.name = name
  }

  public var isEmpty: Bool { cname == nil && name == nil }
}

/// Where a camera's current name came from.
public enum NameOrigin: String, Codable, Sendable {
  /// Following whatever the camera announces, so renaming it on the phone renames it here.
  case advertised
  /// The operator has spoken. The camera no longer overrides it.
  case operatorAssigned
}

/// What the operator named, and what persists across launches. The durable entity.
///
/// Keyed by a UUID rather than by the name, because the name is a label the operator edits
/// mid-game. If the name were the key, every rename would orphan that camera's archive segments
/// and telemetry history.
public struct CameraRecord: Hashable, Sendable, Codable, Identifiable {
  public let id: UUID
  public var name: String
  public var nameOrigin: NameOrigin
  /// Last name the camera announced, kept whether or not it is the name in use, so the UI can
  /// offer to go back to following the camera after an operator rename.
  public var advertisedName: String?
  /// Last `CNAME` this camera presented. SDP/RTCP identity for cameras that do not publish
  /// `_awx_service._tcp` TXT — GS Cameraman puts its UUID here.
  public var lastKnownCNAME: String?
  /// Address this camera answered on in the current session. Never persisted: IP is not identity.
  public var lastKnownHost: String
  /// Stable id from `_awx_service._tcp` TXT: `modelname` first, else `wlanmac`. Nil for cameras
  /// that do not advertise NearStream identity.
  public var hardwareID: String?
  public var lastSeenAt: Date
  /// The smoothing buffer this camera settled on last time it was used. A camera's jitter comes
  /// from its own encoder settings, so it is much the same game to game, and remembering it means
  /// the picture is smooth from the first second rather than from the tenth.
  public var playoutMilliseconds: Double?

  public init(
    id: UUID = UUID(),
    name: String,
    nameOrigin: NameOrigin = .operatorAssigned,
    advertisedName: String? = nil,
    lastKnownCNAME: String? = nil,
    lastKnownHost: String,
    lastSeenAt: Date,
    hardwareID: String? = nil,
    playoutMilliseconds: Double? = nil
  ) {
    self.id = id
    self.name = name
    self.nameOrigin = nameOrigin
    self.advertisedName = advertisedName
    self.lastKnownCNAME = lastKnownCNAME
    self.lastKnownHost = lastKnownHost
    self.lastSeenAt = lastSeenAt
    self.hardwareID = hardwareID
    self.playoutMilliseconds = playoutMilliseconds
  }

  /// Decoded by hand because a cache written before cameras had identity has none of these keys,
  /// and the synthesised decoder would throw on the first missing one — taking every named camera
  /// on the iPad with it.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(UUID.self, forKey: .id)
    name = try container.decode(String.self, forKey: .name)
    nameOrigin = try container.decodeIfPresent(NameOrigin.self, forKey: .nameOrigin) ?? .operatorAssigned
    advertisedName = try container.decodeIfPresent(String.self, forKey: .advertisedName)
    lastKnownCNAME = try container.decodeIfPresent(String.self, forKey: .lastKnownCNAME)
    // Discards a previously persisted address. Matching by IP is how the wrong camera takes a tile
    // after DHCP; the host is session state only.
    lastKnownHost = ""
    lastSeenAt = try container.decode(Date.self, forKey: .lastSeenAt)
    hardwareID = try container.decodeIfPresent(String.self, forKey: .hardwareID)
    playoutMilliseconds = try container.decodeIfPresent(Double.self, forKey: .playoutMilliseconds)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(name, forKey: .name)
    try container.encode(nameOrigin, forKey: .nameOrigin)
    try container.encodeIfPresent(advertisedName, forKey: .advertisedName)
    try container.encodeIfPresent(lastKnownCNAME, forKey: .lastKnownCNAME)
    try container.encode(lastSeenAt, forKey: .lastSeenAt)
    try container.encodeIfPresent(hardwareID, forKey: .hardwareID)
    try container.encodeIfPresent(playoutMilliseconds, forKey: .playoutMilliseconds)
  }

  /// Only NearStream TXT (`hardwareID`) or RTSP SDP/RTCP `CNAME` is durable. An IP-only camera is
  /// session-scoped and must not be written to disk.
  public var hasHardenedIdentity: Bool {
    if let hardwareID, !hardwareID.isEmpty { return true }
    if let lastKnownCNAME, !lastKnownCNAME.isEmpty { return true }
    return false
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case name
    case nameOrigin
    case advertisedName
    case lastKnownCNAME
    case lastKnownHost
    case hardwareID
    case lastSeenAt
    case playoutMilliseconds
  }
}

/// This session's association between an endpoint and a record.
public struct CameraBinding: Hashable, Sendable {
  public enum Origin: String, Hashable, Sendable {
    /// Matched because `_awx_service._tcp` TXT identified this camera (modelname, else wlanmac).
    case autoByIdentity
    /// Matched on the identifier the camera presented in SDP/RTCP. Survives a lease change.
    case autoByCNAME
    /// Session-only: the operator paired this address. Not restored from disk.
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
    guard let cameraID = binding.cameraID else { return anonymousID(for: binding.endpoint) }
    return SourceID(cameraID.uuidString)
  }

  /// Unidentified cameras are keyed by where they answer. The port is part of the key so four
  /// farm processes on one Mac IP (18554–18557) do not collapse into one row.
  public static func anonymousID(for endpoint: CameraEndpoint) -> SourceID {
    if endpoint.port == 554 {
      return SourceID("camera-\(endpoint.host)")
    }
    return SourceID("camera-\(endpoint.host)-\(endpoint.port)")
  }

  // MARK: - Automatic binding

  /// One media address per camera. The same phone on Wi-Fi and a link-local interface, or a VM33
  /// found by both TXT and the subnet scan, must not become two rows.
  public static func deduplicate(
    endpoints: [CameraEndpoint],
    advertisements: [CameraAdvertisement]
  ) -> (endpoints: [CameraEndpoint], advertisements: [CameraAdvertisement]) {
    let adsByHost = Dictionary(
      advertisements.map { ($0.host, $0) },
      uniquingKeysWith: { _, latest in latest }
    )

    var groups: [String: [CameraEndpoint]] = [:]
    var unidentified: [CameraEndpoint] = []
    for endpoint in sorted(endpoints) {
      if let uniqueID = adsByHost[endpoint.host]?.uniqueID {
        groups[uniqueID, default: []].append(endpoint)
      } else {
        unidentified.append(endpoint)
      }
    }

    let orphanAds = advertisements.filter { advertisement in
      guard let uniqueID = advertisement.uniqueID else { return false }
      let members = groups[uniqueID] ?? []
      return !members.contains { CameraAdvertisement.isUsableMediaHost($0.host) }
    }
    if orphanAds.count == 1, unidentified.count == 1,
       let uniqueID = orphanAds[0].uniqueID, let leftover = unidentified.first {
      groups[uniqueID, default: []].append(leftover)
      unidentified = []
    }

    var chosen: [CameraEndpoint] = []
    var rewritten: [String: CameraAdvertisement] = [:]
    for advertisement in advertisements {
      guard let uniqueID = advertisement.uniqueID else {
        rewritten[advertisement.host] = advertisement
        continue
      }
      let members = groups[uniqueID] ?? []
      let winner = preferredEndpoint(members, advertisement: advertisement)
      var next = advertisement
      if let winner {
        next.host = winner.host
        chosen.append(winner)
      }
      rewritten[uniqueID] = next
    }

    let claimedHosts = Set(chosen.map(\.host))
    for endpoint in unidentified where !claimedHosts.contains(endpoint.host) {
      chosen.append(endpoint)
    }

    let uniqueChosen = Array(Set(chosen))
    return (sorted(uniqueChosen), Array(rewritten.values))
  }

  /// Pairs endpoints with records. TXT unique ids outrank `CNAME`. Address is never a match key:
  /// DHCP would otherwise silently put the wrong camera on a tile.
  public static func autoBind(
    endpoints: [CameraEndpoint],
    records: [CameraRecord],
    advertisements: [String: CameraAdvertisement] = [:],
    streamAdvertisements: [CameraEndpoint: StreamAdvertisement] = [:]
  ) -> [CameraBinding] {
    var claimed: Set<UUID> = []
    var bindings: [CameraEndpoint: CameraBinding] = [:]

    for endpoint in sorted(endpoints) {
      guard
        let uniqueID = advertisements[endpoint.host]?.uniqueID,
        let record = records.first(where: { $0.hardwareID == uniqueID && !claimed.contains($0.id) })
      else { continue }
      claimed.insert(record.id)
      bindings[endpoint] = CameraBinding(endpoint: endpoint, cameraID: record.id, origin: .autoByIdentity)
    }

    for endpoint in sorted(endpoints) where bindings[endpoint] == nil {
      guard
        let cname = streamAdvertisements[endpoint]?.cname,
        let record = records.first(where: { $0.lastKnownCNAME == cname && !claimed.contains($0.id) })
      else { continue }
      claimed.insert(record.id)
      bindings[endpoint] = CameraBinding(endpoint: endpoint, cameraID: record.id, origin: .autoByCNAME)
    }

    for endpoint in sorted(endpoints) where bindings[endpoint] == nil {
      bindings[endpoint] = CameraBinding(endpoint: endpoint)
    }

    return sorted(endpoints).compactMap { bindings[$0] }
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
    advertisements: [String: CameraAdvertisement] = [:],
    streamAdvertisements: [CameraEndpoint: StreamAdvertisement] = [:]
  ) -> [CameraBinding] {
    let live = Set(endpoints)
    var kept: [CameraEndpoint: CameraBinding] = [:]
    var claimed: Set<UUID> = []

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

    let free = endpoints.filter { kept[$0] == nil }
    let resolved = autoBind(
      endpoints: free,
      records: records.filter { !claimed.contains($0.id) },
      advertisements: advertisements,
      streamAdvertisements: streamAdvertisements
    )

    var byEndpoint = kept
    for binding in resolved { byEndpoint[binding.endpoint] = binding }
    return sorted(endpoints).compactMap { byEndpoint[$0] }
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
    nameOrigin: NameOrigin = .operatorAssigned,
    advertisedName: String? = nil,
    lastKnownCNAME: String? = nil,
    in records: inout [CameraRecord]
  ) -> UUID {
    let record = CameraRecord(
      name: uniqueName(name, in: records),
      nameOrigin: nameOrigin,
      advertisedName: advertisedName,
      lastKnownCNAME: lastKnownCNAME,
      lastKnownHost: host,
      lastSeenAt: now,
      hardwareID: hardwareID
    )
    records.append(record)
    return record.id
  }

  /// Folds Bonjour identity into the cache. Existing operator names are never overwritten: the
  /// advertised name is only adopted while the record is still following the camera.
  public static func applyAdvertisements(
    _ advertisements: [CameraAdvertisement],
    to records: inout [CameraRecord],
    now: Date
  ) {
    for advertisement in advertisements {
      guard let uniqueID = advertisement.uniqueID else { continue }
      let advertised = trimmed(advertisement.advertisedName)
      if let position = records.firstIndex(where: { $0.hardwareID == uniqueID }) {
        let keeperID = records[position].id
        records[position].lastKnownHost = advertisement.host
        records[position].lastSeenAt = now
        if let advertised { records[position].advertisedName = advertised }
        if let uuid = advertisement.uuid {
          records[position].lastKnownCNAME = uuid
          records.removeAll { $0.id != keeperID && $0.lastKnownCNAME == uuid }
        }
        if let next = records.firstIndex(where: { $0.id == keeperID }) {
          adoptAdvertisedNameIfFollowing(at: next, in: &records)
        }
        continue
      }
      if let uuid = advertisement.uuid,
         let position = records.firstIndex(where: { $0.lastKnownCNAME == uuid }) {
        records[position].hardwareID = uniqueID
        records[position].lastKnownHost = advertisement.host
        records[position].lastSeenAt = now
        if let advertised { records[position].advertisedName = advertised }
        adoptAdvertisedNameIfFollowing(at: position, in: &records)
        continue
      }
      makeRecord(
        named: advertised ?? advertisement.advertisedName,
        host: advertisement.host,
        now: now,
        hardwareID: uniqueID,
        nameOrigin: advertised == nil ? .operatorAssigned : .advertised,
        advertisedName: advertised,
        lastKnownCNAME: advertisement.uuid,
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

  /// An operator rename stops the camera overriding the name from then on. A camera that renames
  /// itself mid-game must not undo what the operator just typed.
  public static func rename(
    _ cameraID: UUID,
    to name: String,
    in records: inout [CameraRecord]
  ) {
    guard let position = records.firstIndex(where: { $0.id == cameraID }) else { return }
    let others = records.filter { $0.id != cameraID }
    records[position].name = uniqueName(name, in: others)
    records[position].nameOrigin = .operatorAssigned
  }

  // MARK: - What the camera says about itself

  /// Folds live SDP/RTCP claims into the cache. A new `CNAME` becomes a persistable record; IP is
  /// not used to attach the claim to an existing unnamed camera.
  public static func applyStreamAdvertisements(
    _ claims: [CameraEndpoint: StreamAdvertisement],
    to records: inout [CameraRecord],
    now: Date
  ) {
    for (endpoint, claim) in claims {
      guard let cname = trimmed(claim.cname) else { continue }
      if let position = records.firstIndex(where: { $0.lastKnownCNAME == cname }) {
        records[position].lastKnownHost = endpoint.host
        records[position].lastSeenAt = now
        apply(claim, to: records[position].id, in: &records)
        continue
      }
      // GS Cameraman's Bonjour TXT uuid is stored as hardwareID `uuid:…` before DESCRIBE supplies
      // the same string as a CNAME. Matching here keeps one record instead of minting a second.
      if let position = records.firstIndex(where: {
        $0.hardwareID == CameraAdvertisement.uniqueID(modelName: nil, wlanMAC: nil, uuid: cname)
      }) {
        records[position].lastKnownCNAME = cname
        records[position].lastKnownHost = endpoint.host
        records[position].lastSeenAt = now
        apply(claim, to: records[position].id, in: &records)
        continue
      }
      makeRecord(adopting: claim, host: endpoint.host, now: now, in: &records)
    }
  }

  /// Folds an SDP/RTCP advertisement into a record.
  ///
  /// The advertised name is always remembered so the UI can offer it, but it only takes effect
  /// while the record is still following the camera. The `CNAME` is recorded either way, because
  /// identity is not a naming preference — an operator-named camera still has to be findable after
  /// it moves.
  public static func apply(
    _ advertisement: StreamAdvertisement,
    to cameraID: UUID,
    in records: inout [CameraRecord]
  ) {
    guard let position = records.firstIndex(where: { $0.id == cameraID }) else { return }
    if let cname = advertisement.cname { records[position].lastKnownCNAME = cname }

    guard let advertised = trimmed(advertisement.name) else { return }
    // Cameraman Bonjour is the live rename. SDP `s=` is a snapshot from DESCRIBE and must not
    // pull the name back after the operator already renamed the phone.
    if records[position].hardwareID?.hasPrefix("uuid:") == true { return }
    records[position].advertisedName = advertised
    adoptAdvertisedNameIfFollowing(at: position, in: &records)
  }

  /// Puts a record back under the camera's control, adopting the last advertised name at once so
  /// the choice has a visible effect without waiting for the camera to say it again.
  public static func followCamera(
    _ cameraID: UUID,
    in records: inout [CameraRecord]
  ) {
    guard let position = records.firstIndex(where: { $0.id == cameraID }) else { return }
    records[position].nameOrigin = .advertised
    adoptAdvertisedNameIfFollowing(at: position, in: &records)
  }

  /// Creates a record for a camera that introduced itself, taking its name and following it.
  @discardableResult
  public static func makeRecord(
    adopting advertisement: StreamAdvertisement,
    host: String,
    now: Date,
    in records: inout [CameraRecord]
  ) -> UUID {
    let advertised = trimmed(advertisement.name)
    let proposed = advertised ?? nextDefaultName(in: records)
    return makeRecord(
      named: proposed,
      host: host,
      now: now,
      nameOrigin: advertised == nil ? .operatorAssigned : .advertised,
      advertisedName: advertised,
      lastKnownCNAME: advertisement.cname,
      in: &records
    )
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

  private static func hostRank(_ host: String) -> Int {
    if CameraAdvertisement.isUsableMediaHost(host) { return 0 }
    if host.hasPrefix("169.254.") { return 1 }
    if CameraAdvertisement.isUUIDHostname(host) { return 2 }
    return 3
  }

  private static func preferredEndpoint(
    _ endpoints: [CameraEndpoint],
    advertisement: CameraAdvertisement
  ) -> CameraEndpoint? {
    let winner = endpoints.min { left, right in
      let leftRank = hostRank(left.host)
      let rightRank = hostRank(right.host)
      if leftRank != rightRank { return leftRank < rightRank }
      return left.host < right.host
    }
    guard let winner else { return nil }
    return CameraEndpoint(host: winner.host, port: advertisement.port, path: advertisement.path)
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

  private static func trimmed(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func adoptAdvertisedNameIfFollowing(
    at position: Int,
    in records: inout [CameraRecord]
  ) {
    guard records[position].nameOrigin == .advertised,
          let advertised = records[position].advertisedName
    else { return }
    let id = records[position].id
    let others = records.filter { $0.id != id }
    records[position].name = uniqueName(advertised, in: others)
  }
}

/// `UserDefaults` persistence for the named-camera cache.
public struct CameraRecordStore: Sendable {
  private static let key = "co.gamestation.director.cameras"
  private let store: ConfigStore

  public init(store: ConfigStore = ConfigStore()) {
    self.store = store
  }

  public func load() -> [CameraRecord] {
    (store.codableValue([CameraRecord].self, forKey: Self.key) ?? []).filter(\.hasHardenedIdentity)
  }

  public func save(_ records: [CameraRecord]) {
    store.setCodableValue(records.filter(\.hasHardenedIdentity), forKey: Self.key)
  }

  public func clear() {
    store.removeValue(forKey: Self.key)
  }
}
