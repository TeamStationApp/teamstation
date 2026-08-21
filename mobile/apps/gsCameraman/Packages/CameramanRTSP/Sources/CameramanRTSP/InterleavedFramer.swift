import Foundation

/// RTSP interleaved framing, RFC 2326 §10.12: `$ <channel> <16-bit big-endian length> <payload>`.
///
/// Channel assignment follows what GS Producer's `RTSPSession` requests: video on 0 with its RTCP
/// on 1, audio on 2 with its RTCP on 3. The client discards odd channels, but the sender reports
/// still have to go out — ffmpeg and VLC use them for A/V sync, and they carry the SDES CNAME.
public enum InterleavedChannel {
  public static let video: UInt8 = 0
  public static let videoControl: UInt8 = 1
  public static let audio: UInt8 = 2
  public static let audioControl: UInt8 = 3
}

public enum InterleavedFramer {
  /// The largest payload a single frame can carry. RTP packets are budgeted well below this.
  public static let maximumPayloadSize = 0xFFFF

  public static func frame(channel: UInt8, payload: Data) -> Data? {
    guard payload.count <= maximumPayloadSize else { return nil }
    var result = Data(capacity: payload.count + 4)
    result.append(0x24)
    result.append(channel)
    result.append(UInt8((payload.count >> 8) & 0xFF))
    result.append(UInt8(payload.count & 0xFF))
    result.append(payload)
    return result
  }

  public static func frames(channel: UInt8, payloads: [Data]) -> Data {
    var result = Data()
    for payload in payloads {
      if let framed = frame(channel: channel, payload: payload) { result.append(framed) }
    }
    return result
  }
}
