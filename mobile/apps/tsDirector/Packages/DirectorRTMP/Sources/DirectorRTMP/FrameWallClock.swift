import DirectorCore
import Foundation

/// When a programme frame's picture was taken, as the wall-clock SEI it goes out with says.
///
/// The programme hands over its own reading, the content wall its recording's anchors store, and the
/// server clock offset it last measured; this puts the two together. With an offset the frame is on
/// TeamStation's clock and says so (bit 0 of the SEI's flags). Without one it carries the iPad's
/// steady wall clock with the bit clear, which the server takes as approximate: still frame-exact
/// against itself, just not against the scoring.
public struct FrameWallClock: Sendable, Equatable {
  /// When the picture was captured, in milliseconds since 1970 on Director's steady wall clock.
  public var contentWallMs: Int64
  /// TeamStation's clock less Director's, in milliseconds, or nil when it has not been measured.
  public var serverClockOffsetMs: Int?

  public init(contentWallMs: Int64, serverClockOffsetMs: Int?) {
    self.contentWallMs = contentWallMs
    self.serverClockOffsetMs = serverClockOffsetMs
  }

  /// The wall the SEI carries: on the server's clock when the offset is known.
  public var wallMs: Int64 { contentWallMs + Int64(serverClockOffsetMs ?? 0) }

  /// Whether the wall has been moved onto the server's clock.
  public var corrected: Bool { serverClockOffsetMs != nil }

  /// `payload`, length-prefixed NAL units as VideoToolbox hands them over, with this frame's SEI
  /// inserted after whatever comes before the first slice and so ahead of the picture, where every
  /// SEI of an access unit belongs. A payload with no slice gets it at the end; one whose lengths
  /// run past its end gets it after the last whole unit.
  public func inserted(into payload: Data, codec: RTMPVideoCodec, lengthSize: Int = 4) -> Data {
    let seiCodec: WallClockSEI.Codec = codec == .hevc ? .hevc : .h264
    let sei = WallClockSEI.encode(seiCodec, wallMs: wallMs, corrected: corrected)
    let bytes = [UInt8](payload)
    var at = 0
    var offset = 0
    while offset + lengthSize < bytes.count {
      let length = bytes[offset ..< offset + lengthSize].reduce(0) { ($0 << 8) | Int($1) }
      let start = offset + lengthSize
      guard length > 0, start + length <= bytes.count else { break }
      if WallClockSEI.isSlice(seiCodec, header: bytes[start]) { break }
      offset = start + length
      at = offset
    }
    var prefix = [UInt8](repeating: 0, count: lengthSize)
    var remaining = sei.count
    for index in stride(from: lengthSize - 1, through: 0, by: -1) {
      prefix[index] = UInt8(truncatingIfNeeded: remaining)
      remaining >>= 8
    }
    var out = Data(capacity: payload.count + lengthSize + sei.count)
    out.append(contentsOf: bytes[..<at])
    out.append(contentsOf: prefix)
    out.append(sei)
    out.append(contentsOf: bytes[at...])
    return out
  }
}

extension FLVTag {
  /// One coded picture for `codec`, carrying `wallClock` in an SEI ahead of its slices.
  public static func videoFrame(
    codec: RTMPVideoCodec,
    keyframe: Bool,
    payload: Data,
    wallClock: FrameWallClock
  ) -> Data {
    videoFrame(codec: codec, keyframe: keyframe, payload: wallClock.inserted(into: payload, codec: codec))
  }
}
