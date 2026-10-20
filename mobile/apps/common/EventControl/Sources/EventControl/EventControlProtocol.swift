import Foundation
import Security

/// The fixed numbers of device event control, version 2. README.md is the specification; these are
/// its constants, in one place for both ends.
public enum EventControlProtocol {
  /// The only version this package speaks. A frame of any other version changes nothing.
  public static let version: UInt8 = 2

  /// A receiver listens on the first of these it can bind. Two, so that two participating apps on
  /// one handset can both listen; which one a receiver got says nothing about what it is.
  public static let ports: [UInt16] = [ 47614, 47615 ]

  /// The most a frame's payload may be. A longer declared length closes the connection before
  /// anything is allocated for it.
  public static let maxPayloadBytes = 4096

  /// How often a Director renews a lease it holds.
  public static let renewInterval: TimeInterval = 5

  /// How long a receiver keeps a lease after the last assign or renew that held it.
  public static let leaseDuration: TimeInterval = 15

  /// Sizes of the fixed-width fields.
  public static let instanceIdBytes = 16
  public static let nonceBytes = 16
  public static let accountTagBytes = 16
  public static let keyIdBytes = 8
  public static let keyBytes = 32
  public static let macBytes = 32

  /// Domain separation for every MAC and derivation, so a value made for one purpose can never be
  /// accepted for another.
  public static let keyDomain = "device-event-control:v2"
  public static let keyIdDomain = "device-event-control:v2:keyid"
  public static let accountTagDomain = "device-event-control:v2:account-tag"
  public static let frameDomain = "device-event-control:v2:frame"
}

/// Bytes, hex and the length-prefixed encoding every field uses.
public enum EventControlBytes {
  /// Lower-case hex.
  public static func hex(_ data: Data) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    out.reserveCapacity(data.count * 2)
    for byte in data {
      out.append(digits[Int(byte >> 4)])
      out.append(digits[Int(byte & 0x0F)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Bytes from hex of either case; nil for an odd length or any other character.
  public static func data(hex: String) -> Data? {
    let utf8 = Array(hex.utf8)
    guard utf8.count % 2 == 0 else { return nil }
    var out = Data(capacity: utf8.count / 2)
    var index = 0
    while index < utf8.count {
      guard let high = nibble(utf8[index]), let low = nibble(utf8[index + 1]) else { return nil }
      out.append(high << 4 | low)
      index += 2
    }
    return out
  }

  private static func nibble(_ char: UInt8) -> UInt8? {
    switch char {
    case UInt8(ascii: "0") ... UInt8(ascii: "9"): return char - UInt8(ascii: "0")
    case UInt8(ascii: "a") ... UInt8(ascii: "f"): return char - UInt8(ascii: "a") + 10
    case UInt8(ascii: "A") ... UInt8(ascii: "F"): return char - UInt8(ascii: "A") + 10
    default: return nil
    }
  }

  /// Eight bytes, big-endian.
  public static func u64(_ value: UInt64) -> Data {
    var out = Data(count: 8)
    for index in 0 ..< 8 {
      out[index] = UInt8(truncatingIfNeeded: value >> (56 - 8 * UInt64(index)))
    }
    return out
  }

  /// A big-endian unsigned integer from up to eight bytes.
  public static func readU64(_ data: Data) -> UInt64 {
    data.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
  }

  /// `u16be(byteCount) || bytes` for each part in turn. A part over 65535 bytes is a programming
  /// error: every field this protocol defines is bounded far below that.
  public static func lengthPrefixed(_ parts: [Data]) -> Data {
    var out = Data()
    for part in parts {
      precondition(part.count <= 0xFFFF, "a field is over 65535 bytes")
      out.append(UInt8(part.count >> 8))
      out.append(UInt8(part.count & 0xFF))
      out.append(part)
    }
    return out
  }

  /// Whether two byte strings are equal, taking the same time wherever they first differ.
  public static func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    var difference: UInt8 = 0
    for (left, right) in zip(lhs, rhs) { difference |= left ^ right }
    return difference == 0
  }

  /// Cryptographically random bytes.
  public static func random(_ count: Int) -> Data {
    var out = Data(count: count)
    let status = out.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
    }
    precondition(status == errSecSuccess, "the system random source failed")
    return out
  }
}
