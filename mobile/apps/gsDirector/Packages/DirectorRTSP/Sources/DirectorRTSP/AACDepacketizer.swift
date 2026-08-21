import Foundation

/// RFC 3640 `mpeg4-generic`, AAC-hbr mode: a 16-bit AU-headers-length in bits, that many bits of
/// per-unit headers, then the units back to back.
///
/// Several access units per packet is normal, and a reader that assumes one silently truncates the
/// audio to a fraction of its real duration.
public struct AACDepacketizer: Sendable {
  private let framing: AACFraming

  public init(framing: AACFraming) {
    self.framing = framing
  }

  public func accessUnits(from packet: RTPPacket) -> [Data] {
    let bytes = [UInt8](packet.payload)
    guard bytes.count > 2 else { return [] }

    let headerBits = Int(bytes[0]) << 8 | Int(bytes[1])
    guard headerBits > 0 else {
      // No AU headers means the whole payload is one unit.
      return [ Data(bytes[2...]) ]
    }

    let headerBytes = (headerBits + 7) / 8
    guard bytes.count >= 2 + headerBytes else { return [] }

    var reader = BitReader(Data(bytes[2 ..< 2 + headerBytes]))
    var sizes: [Int] = []
    var consumedBits = 0
    while consumedBits + framing.sizeLength <= headerBits {
      guard let size = reader.read(bits: framing.sizeLength) else { break }
      consumedBits += framing.sizeLength

      // The first unit carries an AU-index, the rest an AU-index-delta. Neither is needed to slice
      // the payload, but both have to be stepped over or every size after the first is misread.
      let indexBits = sizes.isEmpty ? framing.indexLength : framing.indexDeltaLength
      if indexBits > 0 {
        guard consumedBits + indexBits <= headerBits, reader.read(bits: indexBits) != nil else { break }
        consumedBits += indexBits
      }
      sizes.append(Int(size))
    }

    var units: [Data] = []
    var offset = 2 + headerBytes
    for size in sizes {
      guard size > 0, offset + size <= bytes.count else { break }
      units.append(Data(bytes[offset ..< offset + size]))
      offset += size
    }
    return units
  }
}
