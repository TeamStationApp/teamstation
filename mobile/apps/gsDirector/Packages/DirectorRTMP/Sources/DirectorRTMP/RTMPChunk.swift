import Foundation

public enum RTMPMessageType: UInt8, Sendable {
  case setChunkSize = 1
  case abort = 2
  case acknowledgement = 3
  case userControl = 4
  case windowAckSize = 5
  case setPeerBandwidth = 6
  case audio = 8
  case video = 9
  case amf3Data = 15
  case amf3Command = 17
  case amf0Data = 18
  case amf0Command = 20
}

public struct RTMPMessage: Sendable, Equatable {
  public var streamID: UInt32
  public var type: RTMPMessageType
  public var timestamp: UInt32
  public var payload: Data

  public init(streamID: UInt32, type: RTMPMessageType, timestamp: UInt32, payload: Data) {
    self.streamID = streamID
    self.type = type
    self.timestamp = timestamp
    self.payload = payload
  }
}

public enum RTMPChunk {
  public static let defaultSize = 128

  public static func encode(
    _ message: RTMPMessage,
    chunkStreamID: UInt32,
    chunkSize: Int
  ) -> Data {
    var data = Data()
    let payload = message.payload
    let size = max(chunkSize, 1)
    var offset = 0
    var first = true
    while offset < payload.count || first {
      let remaining = payload.count - offset
      let take = first ? min(size, max(remaining, 0)) : min(size, remaining)
      if first {
        appendBasicHeader(fmt: 0, chunkStreamID: chunkStreamID, into: &data)
        appendUInt24(message.timestamp, into: &data)
        appendUInt24(UInt32(payload.count), into: &data)
        data.append(message.type.rawValue)
        var stream = message.streamID.littleEndian
        withUnsafeBytes(of: &stream) { data.append(contentsOf: $0) }
        if message.timestamp >= 0xFFFFFF {
          var extended = message.timestamp.bigEndian
          withUnsafeBytes(of: &extended) { data.append(contentsOf: $0) }
        }
        first = false
      } else {
        appendBasicHeader(fmt: 3, chunkStreamID: chunkStreamID, into: &data)
        if message.timestamp >= 0xFFFFFF {
          var extended = message.timestamp.bigEndian
          withUnsafeBytes(of: &extended) { data.append(contentsOf: $0) }
        }
      }
      if take > 0 {
        data.append(payload[offset ..< (offset + take)])
        offset += take
      }
      if remaining == 0 { break }
    }
    return data
  }

  private static func appendBasicHeader(fmt: UInt8, chunkStreamID: UInt32, into data: inout Data) {
    if chunkStreamID < 64 {
      data.append((fmt << 6) | UInt8(chunkStreamID))
    } else if chunkStreamID < 320 {
      data.append(fmt << 6)
      data.append(UInt8(chunkStreamID - 64))
    } else {
      data.append((fmt << 6) | 1)
      let value = UInt16(chunkStreamID - 64).littleEndian
      var stored = value
      withUnsafeBytes(of: &stored) { data.append(contentsOf: $0) }
    }
  }

  private static func appendUInt24(_ value: UInt32, into data: inout Data) {
    let clipped = min(value, 0xFFFFFF)
    data.append(UInt8((clipped >> 16) & 0xFF))
    data.append(UInt8((clipped >> 8) & 0xFF))
    data.append(UInt8(clipped & 0xFF))
  }
}

/// Reassembles inbound RTMP chunks into complete messages.
public final class RTMPChunkReader: @unchecked Sendable {
  private struct StreamState {
    var timestamp: UInt32 = 0
    var length: Int = 0
    var type: UInt8 = 0
    var streamID: UInt32 = 0
    var remaining: Int = 0
    var payload = Data()
    var hasHeader = false
  }

  public private(set) var chunkSize = RTMPChunk.defaultSize
  private var buffer = Data()
  private var streams: [UInt32: StreamState] = [:]

  public init() {}

  public func setChunkSize(_ size: Int) {
    chunkSize = max(1, size)
  }

  public func push(_ data: Data) -> [RTMPMessage] {
    buffer.append(data)
    var messages: [RTMPMessage] = []
    while let message = nextMessage() {
      messages.append(message)
    }
    return messages
  }

  private func nextMessage() -> RTMPMessage? {
    guard !buffer.isEmpty else { return nil }
    let first = buffer[0]
    let fmt = first >> 6
    var headerSize = 1
    let csid: UInt32
    if (first & 0x3F) == 0 {
      guard buffer.count >= 2 else { return nil }
      csid = UInt32(buffer[1]) + 64
      headerSize = 2
    } else if (first & 0x3F) == 1 {
      guard buffer.count >= 3 else { return nil }
      csid = (UInt32(buffer[1]) | (UInt32(buffer[2]) << 8)) + 64
      headerSize = 3
    } else {
      csid = UInt32(first & 0x3F)
    }

    var state = streams[csid] ?? StreamState()
    var cursor = headerSize
    func need(_ count: Int) -> Bool { buffer.count >= cursor + count }

    switch fmt {
    case 0:
      guard need(11) else { return nil }
      let timestamp = readUInt24(at: cursor)
      let length = Int(readUInt24(at: cursor + 3))
      let type = buffer[cursor + 6]
      let streamID = readUInt32LE(at: cursor + 7)
      cursor += 11
      var fullTimestamp = timestamp
      if timestamp == 0xFFFFFF {
        guard need(4) else { return nil }
        fullTimestamp = readUInt32BE(at: cursor)
        cursor += 4
      }
      state.timestamp = fullTimestamp
      state.length = length
      state.type = type
      state.streamID = streamID
      state.payload.removeAll(keepingCapacity: true)
      state.remaining = length
      state.hasHeader = true
    case 1:
      guard need(7) else { return nil }
      let delta = readUInt24(at: cursor)
      let length = Int(readUInt24(at: cursor + 3))
      let type = buffer[cursor + 6]
      cursor += 7
      var add = delta
      if delta == 0xFFFFFF {
        guard need(4) else { return nil }
        add = readUInt32BE(at: cursor)
        cursor += 4
      }
      state.timestamp &+= add
      state.length = length
      state.type = type
      if state.remaining == 0 {
        state.payload.removeAll(keepingCapacity: true)
        state.remaining = length
      }
    case 2:
      guard need(3) else { return nil }
      let delta = readUInt24(at: cursor)
      cursor += 3
      var add = delta
      if delta == 0xFFFFFF {
        guard need(4) else { return nil }
        add = readUInt32BE(at: cursor)
        cursor += 4
      }
      state.timestamp &+= add
      if state.remaining == 0 {
        state.payload.removeAll(keepingCapacity: true)
        state.remaining = state.length
      }
    default:
      if state.timestamp >= 0xFFFFFF {
        guard need(4) else { return nil }
        state.timestamp = readUInt32BE(at: cursor)
        cursor += 4
      }
      if state.remaining == 0 {
        state.payload.removeAll(keepingCapacity: true)
        state.remaining = state.length
      }
    }

    let take = min(chunkSize, state.remaining)
    guard buffer.count >= cursor + take else { return nil }
    if take > 0 {
      state.payload.append(buffer[cursor ..< (cursor + take)])
      state.remaining -= take
    }
    buffer.removeSubrange(0 ..< (cursor + take))

    if state.remaining == 0, let type = RTMPMessageType(rawValue: state.type) {
      let message = RTMPMessage(
        streamID: state.streamID,
        type: type,
        timestamp: state.timestamp,
        payload: state.payload
      )
      streams[csid] = state
      return message
    }
    streams[csid] = state
    return nextMessage()
  }

  private func readUInt24(at offset: Int) -> UInt32 {
    (UInt32(buffer[offset]) << 16) | (UInt32(buffer[offset + 1]) << 8) | UInt32(buffer[offset + 2])
  }

  private func readUInt32BE(at offset: Int) -> UInt32 {
    (UInt32(buffer[offset]) << 24)
      | (UInt32(buffer[offset + 1]) << 16)
      | (UInt32(buffer[offset + 2]) << 8)
      | UInt32(buffer[offset + 3])
  }

  private func readUInt32LE(at offset: Int) -> UInt32 {
    UInt32(buffer[offset])
      | (UInt32(buffer[offset + 1]) << 8)
      | (UInt32(buffer[offset + 2]) << 16)
      | (UInt32(buffer[offset + 3]) << 24)
  }
}
