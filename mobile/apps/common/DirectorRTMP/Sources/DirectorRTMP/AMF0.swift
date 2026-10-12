import Foundation

/// AMF0 values used by RTMP connect / createStream / publish / onStatus.
public enum AMF0: Equatable, Sendable {
  case number(Double)
  case boolean(Bool)
  case string(String)
  case object([String: AMF0])
  case null
  case undefined
  case ecmaArray([String: AMF0])
  /// An ordered list. Enhanced RTMP's `fourCcList` in `connect` is one.
  case strictArray([AMF0])

  public var stringValue: String? {
    if case let .string(value) = self { return value }
    return nil
  }

  public var numberValue: Double? {
    if case let .number(value) = self { return value }
    return nil
  }

  public var objectValue: [String: AMF0]? {
    switch self {
    case let .object(value), let .ecmaArray(value): value
    default: nil
    }
  }

  public func encode() -> Data {
    var data = Data()
    encode(into: &data)
    return data
  }

  public static func encode(_ values: [AMF0]) -> Data {
    var data = Data()
    for value in values { value.encode(into: &data) }
    return data
  }

  public static func decodeList(_ data: Data) -> [AMF0] {
    var cursor = 0
    var values: [AMF0] = []
    while cursor < data.count, let value = decode(data, cursor: &cursor) {
      values.append(value)
    }
    return values
  }

  public static func decode(_ data: Data, cursor: inout Int) -> AMF0? {
    guard cursor < data.count else { return nil }
    let marker = data[cursor]
    cursor += 1
    switch marker {
    case 0x00:
      guard cursor + 8 <= data.count else { return nil }
      var bitPattern: UInt64 = 0
      for offset in 0 ..< 8 {
        bitPattern = (bitPattern << 8) | UInt64(data[cursor + offset])
      }
      cursor += 8
      return .number(Double(bitPattern: bitPattern))
    case 0x01:
      guard cursor < data.count else { return nil }
      let value = data[cursor] != 0
      cursor += 1
      return .boolean(value)
    case 0x02:
      guard let string = readString(data, cursor: &cursor, lengthBytes: 2) else { return nil }
      return .string(string)
    case 0x03:
      return readObject(data, cursor: &cursor).map { .object($0) }
    case 0x05:
      return .null
    case 0x06:
      return .undefined
    case 0x08:
      guard cursor + 4 <= data.count else { return nil }
      cursor += 4
      return readObject(data, cursor: &cursor).map { .ecmaArray($0) }
    case 0x0a:
      guard cursor + 4 <= data.count else { return nil }
      var count = 0
      for offset in 0 ..< 4 {
        count = (count << 8) | Int(data[cursor + offset])
      }
      cursor += 4
      var items: [AMF0] = []
      for _ in 0 ..< count {
        guard let item = decode(data, cursor: &cursor) else { return nil }
        items.append(item)
      }
      return .strictArray(items)
    case 0x0c:
      guard let string = readString(data, cursor: &cursor, lengthBytes: 4) else { return nil }
      return .string(string)
    default:
      return nil
    }
  }

  private func encode(into data: inout Data) {
    switch self {
    case let .number(value):
      data.append(0x00)
      var bitPattern = value.bitPattern.bigEndian
      withUnsafeBytes(of: &bitPattern) { data.append(contentsOf: $0) }
    case let .boolean(value):
      data.append(contentsOf: [ 0x01, value ? 1 : 0 ])
    case let .string(value):
      encodeString(value, into: &data, typed: true)
    case let .object(pairs):
      data.append(0x03)
      encodePairs(pairs, into: &data)
    case .null:
      data.append(0x05)
    case .undefined:
      data.append(0x06)
    case let .ecmaArray(pairs):
      data.append(0x08)
      var count = UInt32(pairs.count).bigEndian
      withUnsafeBytes(of: &count) { data.append(contentsOf: $0) }
      encodePairs(pairs, into: &data)
    case let .strictArray(items):
      data.append(0x0A)
      var count = UInt32(items.count).bigEndian
      withUnsafeBytes(of: &count) { data.append(contentsOf: $0) }
      for item in items { item.encode(into: &data) }
    }
  }

  private func encodeString(_ value: String, into data: inout Data, typed: Bool) {
    let utf8 = Array(value.utf8)
    if typed { data.append(0x02) }
    var length = UInt16(utf8.count).bigEndian
    withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
    data.append(contentsOf: utf8)
  }

  private func encodePairs(_ pairs: [String: AMF0], into data: inout Data) {
    for (key, value) in pairs {
      encodeString(key, into: &data, typed: false)
      value.encode(into: &data)
    }
    data.append(contentsOf: [ 0x00, 0x00, 0x09 ])
  }

  private static func readString(_ data: Data, cursor: inout Int, lengthBytes: Int) -> String? {
    guard cursor + lengthBytes <= data.count else { return nil }
    var length = 0
    for offset in 0 ..< lengthBytes {
      length = (length << 8) | Int(data[cursor + offset])
    }
    cursor += lengthBytes
    guard cursor + length <= data.count else { return nil }
    let string = String(decoding: data[cursor ..< (cursor + length)], as: UTF8.self)
    cursor += length
    return string
  }

  private static func readObject(_ data: Data, cursor: inout Int) -> [String: AMF0]? {
    var pairs: [String: AMF0] = [:]
    while true {
      guard let key = readString(data, cursor: &cursor, lengthBytes: 2) else { return nil }
      if key.isEmpty {
        guard cursor < data.count else { return nil }
        if data[cursor] == 0x09 { cursor += 1 }
        return pairs
      }
      guard let value = decode(data, cursor: &cursor) else { return nil }
      pairs[key] = value
    }
  }
}
