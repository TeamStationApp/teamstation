import Foundation

/// A complete coded picture, in the length-prefixed layout VideoToolbox expects.
public struct VideoAccessUnit: Sendable, Equatable {
  /// Concatenated NAL units, each preceded by a 4-byte big-endian length.
  public let data: Data
  public let isKeyframe: Bool
  public let rtpTimestamp: UInt32
  /// Parameter sets seen in-band. These cameras repeat them before every keyframe, which is what
  /// lets a decoder recover after a stream change without a new `DESCRIBE`.
  public let parameterSets: [Data]
  /// A packet went missing while this picture was being assembled, so it would decode into
  /// visible corruption.
  public let isCorrupt: Bool

  public init(
    data: Data,
    isKeyframe: Bool,
    rtpTimestamp: UInt32,
    parameterSets: [Data] = [],
    isCorrupt: Bool = false
  ) {
    self.data = data
    self.isKeyframe = isKeyframe
    self.rtpTimestamp = rtpTimestamp
    self.parameterSets = parameterSets
    self.isCorrupt = isCorrupt
  }

  public var isEmpty: Bool { data.isEmpty && parameterSets.isEmpty }
}

/// A reference type because it holds a partly assembled picture across packets. As a value type an
/// accidental copy would silently fork that state and lose half a frame.
public protocol VideoDepacketizer: AnyObject {
  /// Feeds one packet in. Returns a picture only on the packet that completes it.
  func append(_ packet: RTPPacket, sequenceIntact: Bool) -> VideoAccessUnit?
  /// Number of packets whose payload type this depacketizer does not implement.
  var unsupportedUnits: UInt64 { get }
}

/// Shared assembly: NALs accumulate until the picture ends, and parameter sets are lifted out.
///
/// Parameter sets are kept out of the sample data on purpose. VideoToolbox takes them through the
/// format description, and leaving them in the sample stream makes some decoders reject the frame.
struct AccessUnitAssembler {
  private(set) var nalUnits: [Data] = []
  private(set) var parameterSets: [Data] = []
  private(set) var isKeyframe = false
  private(set) var isCorrupt = false
  private(set) var timestamp: UInt32?

  var isEmpty: Bool { nalUnits.isEmpty && parameterSets.isEmpty }

  mutating func begin(timestamp: UInt32) {
    self.timestamp = timestamp
  }

  mutating func add(nal: Data, isParameterSet: Bool, isKeyframe keyframe: Bool) {
    guard !nal.isEmpty else { return }
    if isParameterSet {
      parameterSets.append(nal)
    } else {
      nalUnits.append(nal)
    }
    if keyframe { isKeyframe = true }
  }

  mutating func markCorrupt() {
    isCorrupt = true
  }

  mutating func take() -> VideoAccessUnit? {
    defer { reset() }
    guard let timestamp, !isEmpty else { return nil }

    var data = Data()
    for nal in nalUnits {
      var length = UInt32(nal.count).bigEndian
      withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
      data.append(nal)
    }
    return VideoAccessUnit(
      data: data,
      isKeyframe: isKeyframe,
      rtpTimestamp: timestamp,
      parameterSets: parameterSets,
      isCorrupt: isCorrupt
    )
  }

  mutating func reset() {
    nalUnits.removeAll(keepingCapacity: true)
    parameterSets.removeAll(keepingCapacity: true)
    isKeyframe = false
    isCorrupt = false
    timestamp = nil
  }
}
