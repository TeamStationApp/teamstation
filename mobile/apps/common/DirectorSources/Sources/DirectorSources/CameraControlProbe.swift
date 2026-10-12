import Foundation

/// What a camera said when it was asked, on its own RTSP port, who it is and whether it takes TS
/// Cameraman's parameter verbs.
///
/// This, not Bonjour, decides whether a tile gets a camera's controls and what identity its record
/// carries. An mDNS record is a discovery shortcut that may never reach this network — an Android
/// Cameraman without a multicast lock, a VLAN the router does not proxy — and a camera found by the
/// address sweep has to end up exactly where one found by Bonjour does.
public enum CameraControlProbeOutcome: Hashable, Sendable {
  /// Answered `device.cname` with its UUID: a Cameraman whose parameters this client can drive when
  /// `controlVersion` is one it speaks.
  case controllable(cname: String, name: String?, controlVersion: String)
  /// Answered, but not with a UUID — refused the verb or the names (405, 451, 501) or replied without
  /// one. A plain RTSP camera.
  case plain
  /// Never answered: refused the connection, closed it, or ran out of time. No controls either, and
  /// asked again after `CameraControlProbes.retrySeconds`.
  case unreachable

  public var isControllable: Bool {
    if case let .controllable(_, _, version) = self {
      return version == CameraAdvertisement.supportedControlVersion
    }
    return false
  }
}

/// The two `GET_PARAMETER` requests the probe makes, and how their replies are read. Pure, so every
/// answer a camera can give is tested without a socket.
///
/// Two requests rather than one because a Cameraman answers an unknown name with `451` and nothing
/// else: one built before `control.version` existed refuses a request that names it, while it
/// answers `device.cname` and `device.name` alone. Asking for those first, and for the version on
/// its own, is what lets today's phones qualify.
public enum CameraControlProbe {
  /// `CameraParameterName.deviceCNAME`, `.deviceName` and `.controlVersion`, spelled out here
  /// because discovery does not link the Cameraman vocabulary.
  public static let cnameName = "device.cname"
  public static let deviceNameName = "device.name"
  public static let controlVersionName = "control.version"

  public static let identityBody = "\(cnameName)\r\n\(deviceNameName)\r\n"
  public static let versionBody = "\(controlVersionName)\r\n"

  /// The UUID and name in the reply to `identityBody`: nil unless it is a success carrying a
  /// non-empty `device.cname`. A server that answers every `GET_PARAMETER` with an empty 200, as a
  /// keep-alive, is not a Cameraman.
  public static func identity(statusCode: Int, body: String) -> (cname: String, name: String?)? {
    guard (200 ..< 300).contains(statusCode) else { return nil }
    let values = parse(body)
    guard let cname = values[cnameName], !cname.isEmpty else { return nil }
    let name = values[deviceNameName].flatMap { $0.isEmpty ? nil : $0 }
    return (cname, name)
  }

  /// The version in the reply to `versionBody`. A camera that refused the name, or did not answer
  /// it, predates the parameter and speaks `params/1`, the only version there was before it.
  public static func controlVersion(statusCode: Int?, body: String?) -> String {
    guard let statusCode, (200 ..< 300).contains(statusCode),
          let version = body.flatMap({ parse($0)[controlVersionName] }), !version.isEmpty
    else { return CameraAdvertisement.supportedControlVersion }
    return version
  }

  /// A `text/parameters` body: `name: value` lines. Values are trimmed; a line without a colon is
  /// skipped.
  public static func parse(_ body: String) -> [String: String] {
    var values: [String: String] = [:]
    for line in body.split(whereSeparator: \.isNewline) {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let name = line[..<colon].trimmingCharacters(in: .whitespaces)
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      guard !name.isEmpty else { continue }
      values[name] = value
    }
    return values
  }
}

/// Each endpoint's last probe, and when to ask again.
///
/// An answer is kept for as long as the camera keeps answering at that address. It is asked again
/// when the address changes (a new endpoint is a new key), when its stream reconnects (`forget`),
/// after `refreshSeconds` so a camera with no Bonjour still has its rename noticed, and after
/// `retrySeconds` when it did not answer at all. A value, so the rules are tested without a clock.
public struct CameraControlProbes: Sendable {
  public struct Entry: Hashable, Sendable {
    public var outcome: CameraControlProbeOutcome
    public var probedAt: Double
  }

  /// How long an endpoint that never answered waits before it is asked again.
  public static let retrySeconds: Double = 30
  /// How long any answer is trusted before it is checked. A Cameraman with no Bonjour is renamed on
  /// the phone, and this is how the new name arrives; one request a minute per camera.
  public static let refreshSeconds: Double = 60

  public private(set) var entries: [CameraEndpoint: Entry] = [:]
  private var inFlight: Set<CameraEndpoint> = []

  public init() {}

  public var outcomes: [CameraEndpoint: CameraControlProbeOutcome] {
    entries.mapValues(\.outcome)
  }

  /// The endpoints among `endpoints` that should be probed now, each marked as being probed so a
  /// sweep that overlaps this one does not ask the same camera twice.
  public mutating func begin(_ endpoints: [CameraEndpoint], now: Double) -> [CameraEndpoint] {
    var due: [CameraEndpoint] = []
    for endpoint in endpoints where !inFlight.contains(endpoint) && !due.contains(endpoint) {
      if let entry = entries[endpoint] {
        let age = now - entry.probedAt
        let limit = entry.outcome == .unreachable ? Self.retrySeconds : Self.refreshSeconds
        guard age >= limit else { continue }
      }
      due.append(endpoint)
    }
    inFlight.formUnion(due)
    return due
  }

  public mutating func finish(_ endpoint: CameraEndpoint, outcome: CameraControlProbeOutcome, now: Double) {
    inFlight.remove(endpoint)
    entries[endpoint] = Entry(outcome: outcome, probedAt: now)
  }

  /// Drops an endpoint's answer so the next look asks again: its stream reconnected, and the camera
  /// behind it may have restarted as another build or another phone.
  public mutating func forget(_ endpoint: CameraEndpoint) {
    entries[endpoint] = nil
  }

  /// Drops the answers of endpoints that no longer answer at all. One that comes back is asked again.
  public mutating func keepOnly(_ endpoints: Set<CameraEndpoint>) {
    entries = entries.filter { endpoints.contains($0.key) }
  }

  /// The advertisements discovery hands on: Bonjour's, corrected by what each camera said itself.
  ///
  /// A controllable answer sets the control version on the Bonjour record with the same UUID, keeping
  /// that record's name and address because Bonjour carries a rename live. With no such record, it
  /// becomes the camera's advertisement, ahead of the rest so it — and not a stale record left on the
  /// same address by a phone that has since moved — describes the endpoint it was asked at. A plain or
  /// unreachable answer takes the control version off any record for that endpoint, or for the UUID
  /// the endpoint presented as its CNAME: the camera's own answer outranks what it once announced.
  public static func merge(
    advertisements: [CameraAdvertisement],
    outcomes: [CameraEndpoint: CameraControlProbeOutcome],
    claims: [CameraEndpoint: StreamAdvertisement] = [:]
  ) -> [CameraAdvertisement] {
    var result = advertisements
    var found: [CameraAdvertisement] = []
    let ordered = outcomes.sorted { ($0.key.host, $0.key.port, $0.key.path) < ($1.key.host, $1.key.port, $1.key.path) }
    for (endpoint, outcome) in ordered {
      switch outcome {
      case let .controllable(cname, name, version):
        let uuid = cname.lowercased()
        if let position = result.firstIndex(where: { $0.uuid?.lowercased() == uuid }) {
          result[position].controlVersion = version
        } else if !found.contains(where: { $0.uuid?.lowercased() == uuid }) {
          found.append(CameraAdvertisement(
            host: endpoint.host,
            advertisedName: name ?? "",
            port: endpoint.port,
            path: endpoint.path,
            uuid: cname,
            controlVersion: version
          ))
        }
      case .plain, .unreachable:
        let claimed = CameraIdentityRules.cameramanUUID(fromCNAME: claims[endpoint]?.cname)
        for position in result.indices
        where result[position].endpoint == endpoint
          || (claimed != nil && result[position].uuid?.lowercased() == claimed) {
          result[position].controlVersion = nil
        }
      }
    }
    return found + result
  }
}
