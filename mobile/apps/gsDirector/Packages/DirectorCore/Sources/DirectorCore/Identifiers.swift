import Foundation

/// Stable identifier for a capture source. For synthetic and file sources it is a generated slug.
public struct SourceID: Hashable, Sendable, Codable, CustomStringConvertible {
  public let rawValue: String

  public init(_ rawValue: String) {
    self.rawValue = rawValue
  }

  public var description: String { rawValue }

  /// Filesystem-safe form used for directory and blob names.
  public var slug: String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    let mapped = rawValue.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
    return String(mapped).prefix(64).description
  }
}

/// Position of a source tile in the 3×3 grid (five sources beside Output).
public struct TileIndex: Hashable, Sendable, Codable, Comparable, CustomStringConvertible {
  public static let count = 5
  public static let all: [TileIndex] = (0 ..< count).map { TileIndex(unchecked: $0) }

  public let value: Int

  /// Fails for anything outside 0...4 so the grid invariant is enforced at the type boundary.
  public init?(_ value: Int) {
    guard (0 ..< TileIndex.count).contains(value) else { return nil }
    self.value = value
  }

  init(unchecked value: Int) {
    self.value = value
  }

  /// 1-based label used in the UI, accessibility values and HUD identifiers.
  public var displayNumber: Int { value + 1 }
  public var description: String { "\(displayNumber)" }

  public static func < (lhs: TileIndex, rhs: TileIndex) -> Bool { lhs.value < rhs.value }
}
