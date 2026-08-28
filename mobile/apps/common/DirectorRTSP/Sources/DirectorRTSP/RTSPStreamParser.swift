import Foundation

/// What arrives on an interleaved RTSP socket: media packets and responses share the connection.
public enum RTSPStreamItem: Sendable, Equatable {
  case interleaved(channel: UInt8, payload: Data)
  case response(RTSPResponse)
}

/// Splits the single TCP stream into media packets and RTSP responses.
///
/// With `RTP/AVP/TCP` the camera frames each packet as `$ <channel> <16-bit length> <payload>` and
/// may put a response between two of them at any time. Reading the socket without this
/// demultiplexing is what turns a keepalive reply into a corrupt video frame.
public struct RTSPStreamParser: Sendable {
  private var buffer = Data()
  /// Bytes already consumed from `buffer`'s current storage. Compact once this is large so
  /// payload copies cannot pin a TCP receive buffer that has already been parsed.
  private var consumedSinceCompact = 0

  public init() {}

  public var bufferedBytes: Int { buffer.count }

  public mutating func append(_ data: Data) {
    buffer.append(data)
  }

  /// Returns the next complete item, or `nil` when more bytes are needed.
  public mutating func next() -> RTSPStreamItem? {
    while let first = buffer.first {
      if first == 0x24 {
        guard buffer.count >= 4 else { return nil }
        let bytes = [UInt8](buffer.prefix(4))
        let length = Int(bytes[2]) << 8 | Int(bytes[3])
        guard buffer.count >= 4 + length else { return nil }
        // dropFirst/prefix is relative to startIndex; `subdata(in: 4..<)` traps after
        // removeFirst because Data's indices are not always zero-based.
        let payload = Data(buffer.dropFirst(4).prefix(length))
        buffer.removeFirst(4 + length)
        consumedSinceCompact += 4 + length
        compactIfNeeded()
        return .interleaved(channel: bytes[1], payload: payload)
      }

      if buffer.starts(with: Data("RTSP/".utf8)) {
        guard let parsed = RTSPResponse.parse(buffer) else { return nil }
        buffer.removeFirst(parsed.consumed)
        consumedSinceCompact += parsed.consumed
        compactIfNeeded()
        return .response(parsed.response)
      }

      // Neither a packet nor a response: resynchronise on the next plausible start rather than
      // discarding the connection, since one stray byte would otherwise end the session.
      guard let resync = Self.nextStart(in: buffer) else {
        buffer.removeAll(keepingCapacity: false)
        consumedSinceCompact = 0
        return nil
      }
      buffer.removeFirst(resync)
      consumedSinceCompact += resync
    }
    compactIfNeeded()
    return nil
  }

  /// `removeFirst` keeps the original storage. Copying the remainder drops that backing store so
  /// RTP payloads cannot pin every byte ever received on the socket.
  private mutating func compactIfNeeded() {
    if buffer.isEmpty {
      buffer = Data()
      consumedSinceCompact = 0
      return
    }
    if consumedSinceCompact > 65_536 {
      buffer = Data(buffer)
      consumedSinceCompact = 0
    }
  }

  private static func nextStart(in data: Data) -> Int? {
    var offset = 1
    let bytes = [UInt8](data)
    while offset < bytes.count {
      if bytes[offset] == 0x24 { return offset }
      if bytes[offset] == 0x52, bytes.count >= offset + 5,
         Array(bytes[offset ..< offset + 5]) == Array("RTSP/".utf8) {
        return offset
      }
      offset += 1
    }
    return nil
  }
}
