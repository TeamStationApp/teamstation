import Foundation

/// Which account a key stands for: the server that issued it and the user on it, plus the opaque
/// tag devices compare on the wire. Never an e-mail address or a name.
public struct EventControlScope: Sendable, Codable, Hashable {
  /// The issuing server's canonical public origin, as the server states it.
  public let issuer: String
  /// The user's ID on that server, in decimal.
  public let userId: String
  /// 32 lower-case hex characters; equal for every device of the account.
  public let accountTag: String

  public init(issuer: String, userId: String, accountTag: String) {
    self.issuer = issuer
    self.userId = userId
    self.accountTag = accountTag
  }
}

/// What `GET /api/v1/device-event-control/key` answers, held by a signed-in device.
///
/// Each device fetches its own with its own session; devices of the same account on the same
/// server hold equal ones. The key authenticates the local protocol and nothing else, so it is
/// kept in the keychain, never in settings, exports, fixtures or logs: `description` leaves it out.
public struct EventControlCredentials: Sendable, Equatable, Codable, CustomStringConvertible,
  CustomDebugStringConvertible
{
  public let scope: EventControlScope
  /// 16 lower-case hex characters naming the server secret the key came from.
  public let keyId: String
  let keyBytes: Data
  let accountTagBytes: Data
  let keyIdBytes: Data

  public enum Problem: Error, Equatable {
    case unsupportedVersion
    case badUserId
    case badAccountTag
    case badKeyId
    case badKey
    case badIssuer
  }

  /// Checks every field's shape; a credential that passes can always sign and verify.
  public init(
    issuer: String,
    userId: String,
    accountTag: String,
    keyId: String,
    key: String
  ) throws(Problem) {
    guard !issuer.isEmpty, issuer.utf8.count <= 512 else { throw .badIssuer }
    guard !userId.isEmpty, userId.utf8.count <= 32,
          userId.utf8.allSatisfy({ (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains($0) })
    else { throw .badUserId }
    guard let tag = Self.lowerHex(accountTag, bytes: EventControlProtocol.accountTagBytes)
    else { throw .badAccountTag }
    guard let id = Self.lowerHex(keyId, bytes: EventControlProtocol.keyIdBytes)
    else { throw .badKeyId }
    guard let secret = Self.lowerHex(key, bytes: EventControlProtocol.keyBytes)
    else { throw .badKey }
    scope = EventControlScope(issuer: issuer, userId: userId, accountTag: accountTag)
    self.keyId = keyId
    keyBytes = secret
    accountTagBytes = tag
    keyIdBytes = id
  }

  private static func lowerHex(_ text: String, bytes: Int) -> Data? {
    guard text.utf8.count == bytes * 2, text == text.lowercased() else { return nil }
    return EventControlBytes.data(hex: text)
  }

  /// The server's JSON reply, as `TeamStationClient`, a Cameraman's own HTTP call or a test has
  /// it. `userId` is read as a string or as a JSON number.
  public static func decode(serverReply data: Data) throws -> EventControlCredentials {
    try JSONDecoder().decode(EventControlCredentials.self, from: data)
  }

  /// Same account on the same server: equal scope and key.
  public func isSameAccount(as other: EventControlCredentials) -> Bool {
    scope == other.scope && keyId == other.keyId
      && EventControlBytes.constantTimeEqual(keyBytes, other.keyBytes)
  }

  public var description: String {
    "EventControlCredentials(issuer: \(scope.issuer), userId: \(scope.userId), "
      + "accountTag: \(scope.accountTag), keyId: \(keyId), key: <redacted>)"
  }

  public var debugDescription: String { description }

  // MARK: - Codable, in the server's shape

  enum CodingKeys: String, CodingKey {
    case version, issuer, userId, accountTag, keyId, key
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 1
    guard version == 1 else { throw Problem.unsupportedVersion }
    let userId: String
    if let text = try? container.decode(String.self, forKey: .userId) {
      userId = text
    } else {
      userId = String(try container.decode(Int64.self, forKey: .userId))
    }
    try self.init(
      issuer: container.decode(String.self, forKey: .issuer),
      userId: userId,
      accountTag: container.decode(String.self, forKey: .accountTag),
      keyId: container.decode(String.self, forKey: .keyId),
      key: container.decode(String.self, forKey: .key)
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(1, forKey: .version)
    try container.encode(scope.issuer, forKey: .issuer)
    try container.encode(scope.userId, forKey: .userId)
    try container.encode(scope.accountTag, forKey: .accountTag)
    try container.encode(keyId, forKey: .keyId)
    try container.encode(EventControlBytes.hex(keyBytes), forKey: .key)
  }

  /// `scheme://host[:port]` in lower case with the scheme's default port dropped: the name a
  /// device files its cached key under, so a key fetched from one server is never offered on
  /// another.
  public static func canonicalOrigin(of url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased(),
          !host.isEmpty
    else { return nil }
    let bracketed = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    switch (scheme, url.port) {
    case (_, nil), ("https", 443), ("http", 80): return "\(scheme)://\(bracketed)"
    case let (_, port?): return "\(scheme)://\(bracketed):\(port)"
    }
  }
}

/// A device's random identity on the protocol: 16 bytes, made once per installation and kept.
///
/// Peers are told apart by it rather than by address, so two apps at one address stay two peers
/// and one device seen at a new address stays one. It identifies nothing about the device.
public struct EventControlInstanceID: Sendable, Hashable, Codable, CustomStringConvertible {
  public let bytes: Data

  public init?(bytes: Data) {
    guard bytes.count == EventControlProtocol.instanceIdBytes else { return nil }
    self.bytes = bytes
  }

  public init?(hex: String) {
    guard let bytes = EventControlBytes.data(hex: hex) else { return nil }
    self.init(bytes: bytes)
  }

  public static func random() -> EventControlInstanceID {
    EventControlInstanceID(bytes: EventControlBytes.random(EventControlProtocol.instanceIdBytes))!
  }

  /// The one kept under `key`, made and kept the first time it is asked for.
  public static func persisted(in defaults: UserDefaults, key: String) -> EventControlInstanceID {
    if let text = defaults.string(forKey: key), let kept = EventControlInstanceID(hex: text) {
      return kept
    }
    let made = random()
    defaults.set(made.hex, forKey: key)
    return made
  }

  public var hex: String { EventControlBytes.hex(bytes) }
  public var description: String { hex }

  public init(from decoder: Decoder) throws {
    let text = try decoder.singleValueContainer().decode(String.self)
    guard let made = EventControlInstanceID(hex: text) else {
      throw DecodingError.dataCorrupted(
        DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Not an instance ID")
      )
    }
    self = made
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(hex)
  }
}
