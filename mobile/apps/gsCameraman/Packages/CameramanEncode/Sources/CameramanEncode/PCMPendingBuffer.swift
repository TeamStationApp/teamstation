import Foundation

/// PCM waiting for a whole AAC frame.
///
/// `Data.removeFirst` keeps the discarded prefix in the unique buffer, so a 48 kHz 16-bit mono
/// microphone (96 KB/s) that is drained as fast as it arrives still climbs ~5.5 MB/min. A read
/// cursor plus an occasional copy of the remainder gives that prefix back to malloc.
public struct PCMPendingBuffer: Sendable {
  public static let compactThreshold = 32 * 1024

  private var storage = Data()
  private var readOffset = 0

  public init() {}

  public var readableCount: Int { storage.count - readOffset }

  /// Allocated bytes including the consumed prefix. Tests use this to prove compact actually
  /// shrinks storage rather than only sliding the cursor.
  public var storedCount: Int { storage.count }

  public mutating func append(_ data: Data) {
    storage.append(data)
  }

  public mutating func take(_ byteCount: Int) -> Data? {
    guard byteCount > 0, readableCount >= byteCount else { return nil }
    let chunk = Data(storage[readOffset..<(readOffset + byteCount)])
    readOffset += byteCount
    return chunk
  }

  public mutating func skip(_ byteCount: Int) {
    guard byteCount > 0 else { return }
    readOffset += min(byteCount, readableCount)
  }

  public mutating func reset(keepingCapacity: Bool = false) {
    storage.removeAll(keepingCapacity: keepingCapacity)
    readOffset = 0
  }

  public mutating func compactIfNeeded() {
    guard readOffset > 0 else { return }
    if readOffset >= storage.count {
      storage.removeAll(keepingCapacity: storage.count <= Self.compactThreshold)
      readOffset = 0
      return
    }
    if readOffset >= Self.compactThreshold || readOffset * 2 >= storage.count {
      storage = Data(storage[readOffset...])
      readOffset = 0
    }
  }
}
