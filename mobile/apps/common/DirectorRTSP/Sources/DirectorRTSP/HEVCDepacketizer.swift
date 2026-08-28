import Foundation

/// RFC 7798: single NAL units, aggregation packets and fragmentation units.
///
/// Deliberately not folded together with the H.264 version. The NAL header is **two** bytes, the
/// type occupies different bits, the aggregate and fragment types are 48 and 49 rather than 24 and
/// 28, and the fragment's start/end bits live in a third byte. Every one of those is a silent
/// wrong-picture bug if the H.264 rules are applied.
public final class HEVCDepacketizer: VideoDepacketizer, @unchecked Sendable {
  private enum NALType {
    /// BLA_W_LP through CRA_NUT: the IRAP range, any of which can start decoding.
    static let irapRange: ClosedRange<UInt8> = 16 ... 21
    static let vps: UInt8 = 32
    static let sps: UInt8 = 33
    static let pps: UInt8 = 34
    static let aggregation: UInt8 = 48
    static let fragmentation: UInt8 = 49
  }

  private var assembler = AccessUnitAssembler()
  private var fragment = Data()
  private var fragmentHeader: (UInt8, UInt8)?
  public private(set) var unsupportedUnits: UInt64 = 0

  public init() {}

  public func append(_ packet: RTPPacket, sequenceIntact: Bool) -> VideoAccessUnit? {
    var completed: VideoAccessUnit?
    if let current = assembler.timestamp, current != packet.timestamp {
      completed = assembler.take()
      fragment.removeAll(keepingCapacity: true)
      fragmentHeader = nil
    }
    if assembler.timestamp == nil { assembler.begin(timestamp: packet.timestamp) }
    if !sequenceIntact { assembler.markCorrupt() }

    parse(packet.payload)

    if packet.marker, completed == nil {
      completed = assembler.take()
      fragment.removeAll(keepingCapacity: true)
      fragmentHeader = nil
    }
    return completed
  }

  private func parse(_ payload: Data) {
    let bytes = [UInt8](payload)
    guard bytes.count >= 2 else { return }
    let type = (bytes[0] >> 1) & 0x3F

    switch type {
    case 0 ... 47:
      add(Data(bytes))
    case NALType.aggregation:
      // 2 bytes of payload header, then repeated [16-bit size][NAL].
      var offset = 2
      while offset + 2 <= bytes.count {
        let size = Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
        offset += 2
        guard size > 0, offset + size <= bytes.count else { return }
        add(Data(bytes[offset ..< offset + size]))
        offset += size
      }
    case NALType.fragmentation:
      guard bytes.count >= 4 else { return }
      let fuHeader = bytes[2]
      let isStart = fuHeader & 0x80 != 0
      let isEnd = fuHeader & 0x40 != 0

      if isStart {
        // Rebuild the two-byte header: keep the forbidden bit and layer id, substitute the type.
        let nalType = fuHeader & 0x3F
        fragmentHeader = ((bytes[0] & 0x81) | (nalType << 1), bytes[1])
        fragment.removeAll(keepingCapacity: true)
      }
      guard let fragmentHeader else {
        assembler.markCorrupt()
        return
      }
      fragment.append(contentsOf: bytes[3...])

      if isEnd {
        var nal = Data([ fragmentHeader.0, fragmentHeader.1 ])
        nal.append(fragment)
        add(nal)
        fragment.removeAll(keepingCapacity: true)
        self.fragmentHeader = nil
      }
    default:
      // PACI (50) and the reserved types.
      unsupportedUnits &+= 1
    }
  }

  private func add(_ nal: Data) {
    guard nal.count >= 2 else { return }
    let type = (nal[nal.startIndex] >> 1) & 0x3F
    let isParameterSet = type == NALType.vps || type == NALType.sps || type == NALType.pps
    assembler.add(
      nal: nal,
      isParameterSet: isParameterSet,
      isKeyframe: NALType.irapRange.contains(type)
    )
  }
}
