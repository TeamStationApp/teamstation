import Foundation

/// RFC 6184: single NAL units, STAP-A aggregates and FU-A fragments.
public final class H264Depacketizer: VideoDepacketizer, @unchecked Sendable {
  private enum NALType {
    static let idr: UInt8 = 5
    static let sps: UInt8 = 7
    static let pps: UInt8 = 8
    static let stapA: UInt8 = 24
    static let fuA: UInt8 = 28
  }

  private var assembler = AccessUnitAssembler()
  private var fragment = Data()
  private var fragmentHeader: UInt8?
  public private(set) var unsupportedUnits: UInt64 = 0

  public init() {}

  public func append(_ packet: RTPPacket, sequenceIntact: Bool) -> VideoAccessUnit? {
    // A timestamp change ends the previous picture even if its marker bit never arrived, which is
    // what stops one dropped final packet from merging two frames into one.
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
    guard let header = bytes.first else { return }
    let type = header & 0x1F

    switch type {
    case 1 ... 23:
      add(Data(bytes))
    case NALType.stapA:
      // 1 byte of STAP-A header, then repeated [16-bit size][NAL].
      var offset = 1
      while offset + 2 <= bytes.count {
        let size = Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
        offset += 2
        guard size > 0, offset + size <= bytes.count else { return }
        add(Data(bytes[offset ..< offset + size]))
        offset += size
      }
    case NALType.fuA:
      guard bytes.count >= 3 else { return }
      let fuHeader = bytes[1]
      let isStart = fuHeader & 0x80 != 0
      let isEnd = fuHeader & 0x40 != 0

      if isStart {
        // The original NAL header is rebuilt from the indicator's F/NRI bits and the FU type.
        fragmentHeader = (bytes[0] & 0xE0) | (fuHeader & 0x1F)
        fragment.removeAll(keepingCapacity: true)
      }
      guard let fragmentHeader else {
        // Joined mid-fragment, so the picture is already incomplete.
        assembler.markCorrupt()
        return
      }
      fragment.append(contentsOf: bytes[2...])

      if isEnd {
        var nal = Data([ fragmentHeader ])
        nal.append(fragment)
        add(nal)
        fragment.removeAll(keepingCapacity: true)
        self.fragmentHeader = nil
      }
    default:
      // STAP-B, MTAP16, MTAP24 and FU-B. No camera here emits them, and guessing at one would
      // produce a decodable-looking frame with the wrong contents.
      unsupportedUnits &+= 1
    }
  }

  private func add(_ nal: Data) {
    guard let header = nal.first else { return }
    let type = header & 0x1F
    assembler.add(
      nal: nal,
      isParameterSet: type == NALType.sps || type == NALType.pps,
      isKeyframe: type == NALType.idr
    )
  }
}
