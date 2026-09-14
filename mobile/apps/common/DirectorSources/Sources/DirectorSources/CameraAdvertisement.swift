import Foundation

/// What a camera published about itself on Bonjour.
///
/// NearStream (`_awx_service._tcp`) uses TXT `modelname` / `wlanmac` for identity; its SRV port is
/// closed and media stays RTSP `:554`. GS Cameraman (`_rtsp._tcp`) puts the UUID in TXT `uuid` and
/// the media port, 8554 on iPhone and Android alike, in the SRV record.
public struct CameraAdvertisement: Hashable, Sendable {
  public var host: String
  public var advertisedName: String
  public var modelName: String?
  public var wlanMAC: String?
  public var isBusy: Bool
  /// Media port. 554 for NearStream; the `_rtsp._tcp` SRV port for GS Cameraman.
  public var port: Int
  /// RTSP path. NearStream and GS Cameraman both use `/live/mainstream` unless TXT `path` says otherwise.
  public var path: String
  /// GS Cameraman TXT `uuid` — the same string as the SDP/RTCP CNAME.
  public var uuid: String?
  /// GS Cameraman TXT `control`: `params/1` when the phone answers RTSP `GET_PARAMETER` /
  /// `SET_PARAMETER` with the camera vocabulary. Absent on older builds and on NearStream.
  public var controlVersion: String?

  public init(
    host: String,
    advertisedName: String,
    modelName: String? = nil,
    wlanMAC: String? = nil,
    isBusy: Bool = false,
    port: Int = 554,
    path: String = "/live/mainstream",
    uuid: String? = nil,
    controlVersion: String? = nil
  ) {
    self.host = host
    self.advertisedName = advertisedName
    self.modelName = Self.trimmed(modelName)
    self.wlanMAC = Self.normalizeMAC(wlanMAC)
    self.isBusy = isBusy
    self.port = port
    self.path = Self.normalizedPath(path)
    self.uuid = Self.trimmed(uuid)
    self.controlVersion = Self.trimmed(controlVersion)
  }

  /// The version this client speaks. A camera advertising anything else gets no control screen.
  public static let supportedControlVersion = "params/1"

  /// A GS Cameraman whose parameters this client can drive: it has a UUID and speaks our version.
  public var isControllable: Bool {
    uuid != nil && controlVersion == Self.supportedControlVersion
  }

  /// `modelname` first, then TXT `wlanmac`, then Cameraman `uuid`. Prefixes keep the namespaces apart.
  public var uniqueID: String? {
    Self.uniqueID(modelName: modelName, wlanMAC: wlanMAC, uuid: uuid)
  }

  public var endpoint: CameraEndpoint {
    CameraEndpoint(host: host, port: port, path: path)
  }

  public static func uniqueID(modelName: String?, wlanMAC: String?, uuid: String? = nil) -> String? {
    if let model = trimmed(modelName), !model.isEmpty {
      return "model:\(model)"
    }
    if let mac = normalizeMAC(wlanMAC) {
      return "mac:\(mac)"
    }
    if let uuid = trimmed(uuid), !uuid.isEmpty {
      return "uuid:\(uuid)"
    }
    return nil
  }

  /// A dotted-quad LAN IPv4. Link-local `169.254.*` and Bonjour UUID hostnames are the same
  /// camera seen on another interface, and must not become a second row.
  public var hasUsableMediaHost: Bool { Self.isUsableMediaHost(host) }

  public static func isUsableMediaHost(_ host: String) -> Bool {
    isLANAddress(host)
  }

  /// A private IPv4: 10/8, 172.16/12 or 192.168/16. A camera on the field is on Director's own
  /// network, so anything else is the phone's other side — its cellular address, advertised for the
  /// moments its Wi-Fi drops. The iPhone on the 2026-09-11 soak advertised 48.146.19.16 twice, Director
  /// moved its live tile there, and the camera was off the air for 20 s each time.
  public static func isLANAddress(_ host: String) -> Bool {
    guard dottedQuad(host) != nil else { return false }
    let octets = host.split(separator: ".").compactMap { UInt8($0) }
    switch (octets[0], octets[1]) {
    case (10, _): return true
    case (172, 16...31): return true
    case (192, 168): return true
    default: return false
    }
  }

  /// Bonjour target like `3278e89a-60d9-411d-a93e-5960cb08de79.local`.
  public static func isUUIDHostname(_ host: String) -> Bool {
    let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
    let withoutDomain = trimmed.lowercased().hasSuffix(".local")
      ? String(trimmed.dropLast(6))
      : trimmed
    return UUID(uuidString: withoutDomain) != nil
  }

  /// Wi-Fi / Ethernet IPv4 wins. A phone plugged into USB also publishes `169.254.*`, which the
  /// iPad cannot reach, so that address must not become the media host.
  public static func preferredMediaHost(among hosts: [String]) -> String? {
    hosts.first { isUsableMediaHost($0) }
  }

  /// TXT keys are matched case-insensitively. `instanceName` is the Bonjour instance (`00D9D 3rd`).
  /// Cameraman also puts the operator name in TXT `name`; that wins when both are present so a
  /// rename is visible even if the instance string lags.
  public static func parseTXT(
    _ fields: [String: String],
    instanceName: String,
    host: String,
    port: Int = 554
  ) -> CameraAdvertisement {
    let lookup = Self.lookup(fields)
    let busy = lookup["busy"]?.lowercased() == "yes"
    let portFromTXT = lookup["port"].flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil }
    return CameraAdvertisement(
      host: host,
      advertisedName: trimmed(lookup["name"]) ?? instanceName,
      modelName: lookup["modelname"],
      wlanMAC: lookup["wlanmac"],
      isBusy: busy,
      port: portFromTXT ?? port,
      path: lookup["path"] ?? "/live/mainstream",
      uuid: lookup["uuid"],
      controlVersion: lookup["control"]
    )
  }

  /// NearStream publishes `ip=` in TXT. The `_awx_service._tcp` SRV port is closed, so a UDP
  /// connect to that port is not a usable way to learn the address.
  public static func ipv4Host(fromTXT fields: [String: String]) -> String? {
    dottedQuad(lookup(fields)["ip"]).flatMap { isLANAddress($0) ? $0 : nil }
  }

  /// Prefer a resolved A-record IPv4 when the path actually produced one; otherwise TXT `ip=`.
  public static func resolvedHost(txtFields: [String: String], pathIPv4: String? = nil) -> String? {
    dottedQuad(pathIPv4).flatMap { isLANAddress($0) ? $0 : nil } ?? ipv4Host(fromTXT: txtFields)
  }

  private static func lookup(_ fields: [String: String]) -> [String: String] {
    Dictionary(uniqueKeysWithValues: fields.map { ($0.key.lowercased(), $0.value) })
  }

  private static func dottedQuad(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4, parts.allSatisfy({ UInt8($0) != nil }) else { return nil }
    return raw
  }

  private static func trimmed(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func normalizedPath(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "/live/mainstream" }
    return trimmed.hasPrefix("/") ? trimmed : "/\(trimmed)"
  }

  /// Canonical `aa:bb:cc:dd:ee:ff`. iOS cannot read LAN MACs itself; this is only the TXT string.
  public static func normalizeMAC(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let hex = raw.lowercased().filter(\.isHexDigit)
    guard hex.count == 12 else { return nil }
    var parts: [String] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      parts.append(String(hex[index..<next]))
      index = next
    }
    return parts.joined(separator: ":")
  }
}
