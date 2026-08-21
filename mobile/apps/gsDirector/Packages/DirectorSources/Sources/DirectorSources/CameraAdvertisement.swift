import Foundation

/// What a camera published about itself on `_awx_service._tcp`.
///
/// The SRV port is not a media port — RTSP stays on 554. This blob is identity: a stable unique id
/// and the name the operator already typed on the camera.
public struct CameraAdvertisement: Hashable, Sendable {
  public var host: String
  public var advertisedName: String
  public var modelName: String?
  public var wlanMAC: String?
  public var isBusy: Bool

  public init(
    host: String,
    advertisedName: String,
    modelName: String? = nil,
    wlanMAC: String? = nil,
    isBusy: Bool = false
  ) {
    self.host = host
    self.advertisedName = advertisedName
    self.modelName = Self.trimmed(modelName)
    self.wlanMAC = Self.normalizeMAC(wlanMAC)
    self.isBusy = isBusy
  }

  /// `modelname` first, then TXT `wlanmac`. Prefixes keep a serial from colliding with a MAC.
  public var uniqueID: String? {
    Self.uniqueID(modelName: modelName, wlanMAC: wlanMAC)
  }

  public static func uniqueID(modelName: String?, wlanMAC: String?) -> String? {
    if let model = trimmed(modelName), !model.isEmpty {
      return "model:\(model)"
    }
    if let mac = normalizeMAC(wlanMAC) {
      return "mac:\(mac)"
    }
    return nil
  }

  /// TXT keys are matched case-insensitively. `instanceName` is the Bonjour instance (`00001 3rd`).
  public static func parseTXT(
    _ fields: [String: String],
    instanceName: String,
    host: String
  ) -> CameraAdvertisement {
    let lookup = Self.lookup(fields)
    let busy = lookup["busy"]?.lowercased() == "yes"
    return CameraAdvertisement(
      host: host,
      advertisedName: instanceName,
      modelName: lookup["modelname"],
      wlanMAC: lookup["wlanmac"],
      isBusy: busy
    )
  }

  /// NearStream publishes `ip=` in TXT. The `_awx_service._tcp` SRV port is closed, so a UDP
  /// connect to that port is not a usable way to learn the address.
  public static func ipv4Host(fromTXT fields: [String: String]) -> String? {
    dottedQuad(lookup(fields)["ip"])
  }

  /// Prefer a resolved A-record IPv4 when the path actually produced one; otherwise TXT `ip=`.
  public static func resolvedHost(txtFields: [String: String], pathIPv4: String? = nil) -> String? {
    dottedQuad(pathIPv4) ?? ipv4Host(fromTXT: txtFields)
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
