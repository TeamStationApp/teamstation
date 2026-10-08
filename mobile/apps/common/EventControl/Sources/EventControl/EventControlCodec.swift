import CryptoKit
import Foundation

/// Why a payload was refused. Nothing refused here ever reaches a state machine.
public enum EventControlCodecError: Error, Equatable, Sendable {
  /// Declared or actual size over 4096 bytes.
  case tooLarge
  /// Too short to hold a version, a type and a MAC.
  case tooShort
  case unsupportedVersion(UInt8)
  case unknownType(UInt8)
  /// A field's length runs past the end of the payload.
  case truncated
  /// A field declares more bytes than its maximum. Checked before anything is read for it.
  case fieldTooLong(index: Int)
  /// A field has a length its kind never has.
  case badFieldLength(index: Int)
  /// Bytes after the last field, before the MAC.
  case trailingBytes
  /// A flag, lease or status byte outside its values.
  case badValue(index: Int)
  /// Text that is not UTF-8.
  case badUTF8(index: Int)
}

/// A payload taken apart: the message, the bytes its MAC covers and the MAC.
public struct EventControlDecoded: Sendable, Equatable {
  public let message: EventControlMessage
  /// Version, type and every field: what the MAC is computed over, after the domain.
  public let signed: Data
  public let mac: Data

  /// Whether `key` made this MAC, compared in constant time.
  public func isAuthentic(key: Data) -> Bool {
    EventControlBytes.constantTimeEqual(EventControlCodec.mac(signed: signed, key: key), mac)
  }

  public func isAuthentic(with credentials: EventControlCredentials) -> Bool {
    isAuthentic(key: credentials.keyBytes)
  }
}

/// The byte-exact encoding of README.md, "Frames":
///
///     frame   = u32be(payloadLength) || payload            1 <= payloadLength <= 4096
///     payload = version(u8) || type(u8) || field* || mac(32)
///     field   = u16be(byteLength) || bytes
///     mac     = HMAC-SHA256(key, lp("device-event-control:v1:frame") || version || type || field*)
public enum EventControlCodec {
  /// Field length bounds in wire order: the six header fields, then the body's.
  struct FieldSpec {
    let min: Int
    let max: Int
    /// Lengths allowed between `min` and `max`; empty means any.
    let only: [Int]

    init(_ exact: Int) {
      min = exact
      max = exact
      only = []
    }

    init(min: Int, max: Int, only: [Int] = []) {
      self.min = min
      self.max = max
      self.only = only
    }

    func allows(_ length: Int) -> Bool {
      length >= min && length <= max && (only.isEmpty || only.contains(length))
    }
  }

  static let headerSpecs: [FieldSpec] = [
    FieldSpec(EventControlProtocol.instanceIdBytes),
    FieldSpec(8),
    FieldSpec(EventControlProtocol.accountTagBytes),
    FieldSpec(EventControlProtocol.keyIdBytes),
    FieldSpec(EventControlProtocol.nonceBytes),
    FieldSpec(min: 0, max: EventControlProtocol.nonceBytes, only: [ 0, EventControlProtocol.nonceBytes ])
  ]

  static func bodySpecs(_ type: EventControlMessageType) -> [FieldSpec] {
    switch type {
    case .discover: return []
    case .announce: return [ FieldSpec(1), FieldSpec(1), FieldSpec(8) ]
    case .assign:
      return [
        FieldSpec(8),
        FieldSpec(min: 1, max: EventAssignment.maxGameIdBytes),
        FieldSpec(min: 1, max: EventAssignment.maxTitleBytes),
        FieldSpec(20)
      ]
    case .ack: return [ FieldSpec(1), FieldSpec(8) ]
    case .renew, .release: return [ FieldSpec(8) ]
    }
  }

  // MARK: - Encoding

  /// The payload for `message`, signed with `key` (32 bytes).
  public static func encode(_ message: EventControlMessage, key: Data) -> Data {
    let signed = signedBytes(message)
    return signed + mac(signed: signed, key: key)
  }

  public static func encode(
    _ message: EventControlMessage,
    with credentials: EventControlCredentials
  ) -> Data {
    encode(message, key: credentials.keyBytes)
  }

  /// A payload with its four-byte length in front, ready for the socket.
  public static func frame(_ payload: Data) -> Data {
    let count = UInt32(payload.count)
    return Data([
      UInt8(count >> 24), UInt8((count >> 16) & 0xFF), UInt8((count >> 8) & 0xFF),
      UInt8(count & 0xFF)
    ]) + payload
  }

  static func signedBytes(_ message: EventControlMessage) -> Data {
    let header = message.header
    var fields: [Data] = [
      header.sender.bytes,
      EventControlBytes.u64(header.requestId),
      header.accountTag,
      header.keyId,
      header.challenge,
      header.receiverNonce
    ]
    switch message.body {
    case .discover:
      break
    case let .announce(consent, lease, revision):
      fields += [ Data([ consent ? 1 : 0 ]), Data([ lease.rawValue ]), EventControlBytes.u64(revision) ]
    case let .assign(revision, gameId, title, startAt):
      fields += [ EventControlBytes.u64(revision), Data(gameId.utf8), Data(title.utf8), Data(startAt.utf8) ]
    case let .ack(status, revision):
      fields += [ Data([ status.rawValue ]), EventControlBytes.u64(revision) ]
    case let .renew(revision), let .release(revision):
      fields += [ EventControlBytes.u64(revision) ]
    }
    return Data([ EventControlProtocol.version, message.type.rawValue ])
      + EventControlBytes.lengthPrefixed(fields)
  }

  /// HMAC-SHA256 over the frame domain and the signed bytes.
  public static func mac(signed: Data, key: Data) -> Data {
    var hmac = HMAC<SHA256>(key: SymmetricKey(data: key))
    hmac.update(data: EventControlBytes.lengthPrefixed([ Data(EventControlProtocol.frameDomain.utf8) ]))
    hmac.update(data: signed)
    return Data(hmac.finalize())
  }

  // MARK: - Decoding

  /// Takes a payload apart, checking every length before reading the bytes it covers. Says
  /// nothing about authenticity: that is `EventControlDecoded.isAuthentic`.
  public static func decode(_ payload: Data) throws(EventControlCodecError) -> EventControlDecoded {
    guard payload.count <= EventControlProtocol.maxPayloadBytes else { throw .tooLarge }
    let bytes = [UInt8](payload)
    guard bytes.count >= 2 else { throw .tooShort }
    guard bytes[0] == EventControlProtocol.version else { throw .unsupportedVersion(bytes[0]) }
    guard let type = EventControlMessageType(rawValue: bytes[1]) else { throw .unknownType(bytes[1]) }
    guard bytes.count >= 2 + EventControlProtocol.macBytes else { throw .tooShort }
    let end = bytes.count - EventControlProtocol.macBytes
    var at = 2
    var fields: [[UInt8]] = []
    for (index, spec) in (headerSpecs + bodySpecs(type)).enumerated() {
      guard end - at >= 2 else { throw .truncated }
      let length = Int(bytes[at]) << 8 | Int(bytes[at + 1])
      guard length <= spec.max else { throw .fieldTooLong(index: index) }
      guard end - at - 2 >= length else { throw .truncated }
      guard spec.allows(length) else { throw .badFieldLength(index: index) }
      fields.append(Array(bytes[at + 2 ..< at + 2 + length]))
      at += 2 + length
    }
    guard at == end else { throw .trailingBytes }

    let header = EventControlHeader(
      sender: EventControlInstanceID(bytes: Data(fields[0]))!,
      requestId: EventControlBytes.readU64(Data(fields[1])),
      accountTag: Data(fields[2]),
      keyId: Data(fields[3]),
      challenge: Data(fields[4]),
      receiverNonce: Data(fields[5])
    )
    let body = try decodeBody(type, Array(fields.dropFirst(headerSpecs.count)))
    return EventControlDecoded(
      message: EventControlMessage(header: header, body: body),
      signed: Data(bytes[0 ..< end]),
      mac: Data(bytes[end...])
    )
  }

  private static func decodeBody(
    _ type: EventControlMessageType,
    _ fields: [[UInt8]]
  ) throws(EventControlCodecError) -> EventControlBody {
    let first = headerSpecs.count
    func text(_ offset: Int) throws(EventControlCodecError) -> String {
      guard let made = String(validating: fields[offset], as: UTF8.self) else {
        throw .badUTF8(index: first + offset)
      }
      return made
    }
    func number(_ offset: Int) -> UInt64 { EventControlBytes.readU64(Data(fields[offset])) }
    switch type {
    case .discover:
      return .discover
    case .announce:
      guard fields[0][0] <= 1 else { throw .badValue(index: first) }
      guard let lease = EventControlLeaseState(rawValue: fields[1][0]) else {
        throw .badValue(index: first + 1)
      }
      return .announce(consent: fields[0][0] == 1, lease: lease, leaseRevision: number(2))
    case .assign:
      return .assign(revision: number(0), gameId: try text(1), title: try text(2), startAt: try text(3))
    case .ack:
      guard let status = EventControlAckStatus(rawValue: fields[0][0]) else {
        throw .badValue(index: first)
      }
      return .ack(status: status, revision: number(1))
    case .renew:
      return .renew(revision: number(0))
    case .release:
      return .release(revision: number(0))
    }
  }
}

/// Splits a byte stream into payloads, refusing an oversized declared length before buffering any
/// of it.
public struct EventControlFrameReader: Sendable {
  private var buffer = Data()

  public init() {}

  /// Every whole payload the stream now holds, in order.
  public mutating func append(_ data: Data) throws(EventControlCodecError) -> [Data] {
    buffer.append(data)
    var out: [Data] = []
    while buffer.count >= 4 {
      let start = buffer.startIndex
      let length = Int(buffer[start]) << 24 | Int(buffer[start + 1]) << 16
        | Int(buffer[start + 2]) << 8 | Int(buffer[start + 3])
      guard length <= EventControlProtocol.maxPayloadBytes else { throw .tooLarge }
      guard length > 0 else { throw .tooShort }
      guard buffer.count >= 4 + length else { break }
      out.append(Data(buffer[start + 4 ..< start + 4 + length]))
      buffer = Data(buffer[(start + 4 + length)...])
    }
    return out
  }

  /// The four-byte length prefix read alone: the payload size, or an error for zero or over 4096.
  public static func payloadLength(_ prefix: Data) throws(EventControlCodecError) -> Int {
    let bytes = [UInt8](prefix)
    guard bytes.count == 4 else { throw .truncated }
    let length = Int(bytes[0]) << 24 | Int(bytes[1]) << 16 | Int(bytes[2]) << 8 | Int(bytes[3])
    guard length <= EventControlProtocol.maxPayloadBytes else { throw .tooLarge }
    guard length > 0 else { throw .tooShort }
    return length
  }
}
