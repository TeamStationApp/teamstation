import Foundation

/// The parts of an RTCP compound packet worth reading (RFC 3550 §6).
///
/// Two things are wanted from it. The sender report pairs an NTP wall clock with an RTP timestamp,
/// which is the only way to put the video and audio clocks on a common timeline. The SDES carries
/// the sender's `CNAME`, a persistent identifier that survives the address changes a DHCP lease
/// hands out, and optionally a human-readable `NAME`.
///
/// Everything here is a pure function over bytes so it can be tested without a camera.
public struct RTCPReport: Sendable, Equatable {
  public struct SenderReport: Sendable, Equatable {
    public let ssrc: UInt32
    /// 64-bit NTP: seconds since 1900 in the high word, fraction in the low.
    public let ntpTimestamp: UInt64
    public let rtpTimestamp: UInt32
    public let packetCount: UInt32
    public let octetCount: UInt32

    public init(
      ssrc: UInt32,
      ntpTimestamp: UInt64,
      rtpTimestamp: UInt32,
      packetCount: UInt32,
      octetCount: UInt32
    ) {
      self.ssrc = ssrc
      self.ntpTimestamp = ntpTimestamp
      self.rtpTimestamp = rtpTimestamp
      self.packetCount = packetCount
      self.octetCount = octetCount
    }

    /// The wall clock the sender says this RTP timestamp corresponds to.
    public var ntpDate: Date {
      let seconds = Double(ntpTimestamp >> 32)
      let fraction = Double(ntpTimestamp & 0xFFFF_FFFF) / Double(1 << 32)
      return Date(timeIntervalSince1970: seconds + fraction - Self.secondsFrom1900To1970)
    }

    private static let secondsFrom1900To1970: Double = 2_208_988_800
  }

  /// One source's SDES items. Only the two that carry identity are kept; the rest are skipped
  /// rather than rejected, because a sender may list any of the eight RFC 3550 types.
  public struct SourceDescription: Sendable, Equatable {
    public let ssrc: UInt32
    public let cname: String?
    public let name: String?

    public init(ssrc: UInt32, cname: String?, name: String?) {
      self.ssrc = ssrc
      self.cname = cname
      self.name = name
    }
  }

  public var senderReports: [SenderReport] = []
  public var sourceDescriptions: [SourceDescription] = []

  public init(
    senderReports: [SenderReport] = [],
    sourceDescriptions: [SourceDescription] = []
  ) {
    self.senderReports = senderReports
    self.sourceDescriptions = sourceDescriptions
  }

  public var isEmpty: Bool { senderReports.isEmpty && sourceDescriptions.isEmpty }

  /// First CNAME in the packet. A compound packet must carry one (RFC 3550 §6.1) and in practice
  /// carries exactly one, because a camera is a single synchronisation source.
  public var cname: String? { sourceDescriptions.compactMap(\.cname).first }
  public var name: String? { sourceDescriptions.compactMap(\.name).first }

  private enum PayloadType {
    static let senderReport: UInt8 = 200
    static let sourceDescription: UInt8 = 202
  }

  private enum SDESItem {
    static let end: UInt8 = 0
    static let cname: UInt8 = 1
    static let name: UInt8 = 2
  }

  /// Walks a compound packet, keeping what it recognises.
  ///
  /// Returns nil only when the bytes are not RTCP at all. A packet whose first element parses and
  /// whose later elements do not still yields what was read, since a receiver that discards a
  /// whole compound packet over one unfamiliar element learns nothing from cameras that append
  /// vendor extensions.
  public static func parse(_ data: Data) -> RTCPReport? {
    var report = RTCPReport()
    var offset = data.startIndex
    var sawAnyElement = false

    while offset + 4 <= data.endIndex {
      let version = data[offset] >> 6
      guard version == 2 else { return sawAnyElement ? report : nil }

      let payloadType = data[offset + 1]
      // Length is in 32-bit words not counting the first, so the element spans (length + 1) words.
      let words = Int(UInt16(data[offset + 2]) << 8 | UInt16(data[offset + 3]))
      let elementCount = (words + 1) * 4
      guard offset + elementCount <= data.endIndex else { return sawAnyElement ? report : nil }

      let element = data[offset ..< offset + elementCount]
      sawAnyElement = true

      switch payloadType {
      case PayloadType.senderReport:
        if let sr = parseSenderReport(element) { report.senderReports.append(sr) }
      case PayloadType.sourceDescription:
        // The low five bits of the first byte count the chunks, not the report blocks.
        report.sourceDescriptions += parseSourceDescription(element, chunkCount: Int(data[offset] & 0x1F))
      default:
        break
      }

      offset += elementCount
    }

    return sawAnyElement ? report : nil
  }

  /// Header, then a 20-byte sender-information block. Any report blocks that follow describe what
  /// the sender received from us, which a receiver has no use for.
  private static func parseSenderReport(_ element: Data) -> SenderReport? {
    guard element.count >= 28 else { return nil }
    let base = element.startIndex
    return SenderReport(
      ssrc: uint32(element, at: base + 4),
      ntpTimestamp: UInt64(uint32(element, at: base + 8)) << 32 | UInt64(uint32(element, at: base + 12)),
      rtpTimestamp: uint32(element, at: base + 16),
      packetCount: uint32(element, at: base + 20),
      octetCount: uint32(element, at: base + 24)
    )
  }

  /// Chunks of `SSRC` followed by type/length/value items, each chunk terminated by a zero byte and
  /// padded to a 32-bit boundary.
  private static func parseSourceDescription(_ element: Data, chunkCount: Int) -> [SourceDescription] {
    var descriptions: [SourceDescription] = []
    var offset = element.startIndex + 4

    for _ in 0 ..< chunkCount {
      guard offset + 4 <= element.endIndex else { break }
      let ssrc = uint32(element, at: offset)
      offset += 4

      var cname: String?
      var name: String?

      items: while offset < element.endIndex {
        let type = element[offset]
        if type == SDESItem.end {
          offset += 1
          break items
        }
        guard offset + 2 <= element.endIndex else { break items }
        let count = Int(element[offset + 1])
        let valueStart = offset + 2
        guard valueStart + count <= element.endIndex else { break items }

        let value = String(decoding: element[valueStart ..< valueStart + count], as: UTF8.self)
        switch type {
        case SDESItem.cname: cname = value
        case SDESItem.name: name = value
        default: break
        }
        offset = valueStart + count
      }

      // The terminator is followed by padding to the next 32-bit boundary.
      let consumed = offset - element.startIndex
      offset += (4 - consumed % 4) % 4

      if cname != nil || name != nil {
        descriptions.append(SourceDescription(ssrc: ssrc, cname: cname, name: name))
      }
    }

    return descriptions
  }

  private static func uint32(_ data: Data, at offset: Int) -> UInt32 {
    UInt32(data[offset]) << 24
      | UInt32(data[offset + 1]) << 16
      | UInt32(data[offset + 2]) << 8
      | UInt32(data[offset + 3])
  }
}
