import Foundation

/// Holds frames until the moment they are due.
///
/// Compressed pictures, not decoded ones. Half a second of 1080p is eighteen frames, which is 56 MB
/// as `CVPixelBuffer`s and 450 KB as the access units they arrived as — and four cameras of the
/// former is more memory than the app is allowed. Decoding on the way out costs a few milliseconds
/// per frame and nothing in memory.
///
/// Order is by due time, then by arrival, so pictures sharing a timestamp keep the order the camera
/// sent them in.
public struct PlayoutQueue<Element>: Sendable where Element: Sendable {
  private struct Entry: Sendable {
    let due: Double
    let sequence: UInt64
    let element: Element
  }

  private var entries: [Entry] = []
  private var nextSequence: UInt64 = 0

  public init() {}

  public var count: Int { entries.count }
  public var isEmpty: Bool { entries.isEmpty }
  public var earliestDue: Double? { entries.first?.due }

  /// Adds `element`, and returns how many entries it trimmed from the front to stay within
  /// `maximum`: pictures received and never shown, which the caller counts.
  @discardableResult
  public mutating func enqueue(_ element: Element, due: Double, keepingAtMost maximum: Int? = nil) -> Int {
    let entry = Entry(due: due, sequence: nextSequence, element: element)
    nextSequence &+= 1
    entries.insert(entry, at: insertionPoint(for: entry))
    guard let maximum, maximum > 0, entries.count > maximum else { return 0 }
    let trimmed = entries.count - maximum
    entries.removeFirst(trimmed)
    return trimmed
  }

  /// Everything due by now, oldest first.
  public mutating func release(at now: Double) -> [Element] {
    var due = 0
    while due < entries.count, entries[due].due <= now { due += 1 }
    guard due > 0 else { return [] }
    let released = entries.prefix(due).map(\.element)
    entries.removeFirst(due)
    return released
  }

  public mutating func removeAll() {
    entries.removeAll(keepingCapacity: true)
  }

  /// Frames arrive in order almost always, so the search starts from the end.
  private func insertionPoint(for entry: Entry) -> Int {
    var low = 0
    var high = entries.count
    while low < high {
      let middle = (low + high) / 2
      if (entries[middle].due, entries[middle].sequence) <= (entry.due, entry.sequence) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return low
  }
}
