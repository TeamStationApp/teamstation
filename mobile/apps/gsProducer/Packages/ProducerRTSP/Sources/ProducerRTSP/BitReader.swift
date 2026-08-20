import Foundation

/// Big-endian bit cursor over a byte buffer. RTP payload formats pack fields across byte
/// boundaries — AAC's AU headers are 13 + 3 bits — so byte-wise reading cannot express them.
struct BitReader {
  private let bytes: [UInt8]
  private var bitOffset = 0

  init(_ data: Data) {
    bytes = [UInt8](data)
  }

  var bitsRemaining: Int { bytes.count * 8 - bitOffset }

  /// Reads up to 32 bits. Returns `nil` rather than truncating, because a short read here means a
  /// malformed packet and continuing on a partial value produces a plausible-looking wrong answer.
  mutating func read(bits count: Int) -> UInt32? {
    guard count > 0, count <= 32, bitsRemaining >= count else { return nil }
    var value: UInt32 = 0
    for _ in 0 ..< count {
      let byte = bytes[bitOffset >> 3]
      let bit = (byte >> (7 - UInt8(bitOffset & 7))) & 1
      value = (value << 1) | UInt32(bit)
      bitOffset += 1
    }
    return value
  }

  mutating func alignToByte() {
    if bitOffset & 7 != 0 { bitOffset += 8 - (bitOffset & 7) }
  }

  var byteOffset: Int { (bitOffset + 7) / 8 }
}
