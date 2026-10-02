import CoreGraphics
import Foundation
import DirectorCore

/// The corner of the director grid that Output's merged 2×2 cell sits in. The operator drags it
/// there; the five source tiles take whichever cells it leaves free.
public enum ProgramCorner: String, CaseIterable, Hashable, Sendable, Codable {
  case topLeading
  case topTrailing
  case bottomLeading
  case bottomTrailing

  public init(isTop: Bool, isLeading: Bool) {
    switch (isTop, isLeading) {
    case (true, true): self = .topLeading
    case (true, false): self = .topTrailing
    case (false, true): self = .bottomLeading
    case (false, false): self = .bottomTrailing
    }
  }

  public var isTop: Bool { self == .topLeading || self == .topTrailing }
  public var isLeading: Bool { self == .topLeading || self == .bottomLeading }
}

/// On-screen arrangement of the director grid: the corner Output sits in and the order of the five
/// source tiles around it. The value at each slot is a source number, so Source 1 stays in the
/// slot the operator parked it in even when a different camera is mapped onto that source.
public struct SourceLayout: Hashable, Sendable, Codable, Equatable {
  /// Visual slot 0…4 → source index 0…4. Slots are the cells Output leaves free, in reading order:
  /// with Output top-left, slot 0 is top-right, 1 mid-right, 2–4 the bottom row.
  public var order: [Int]
  public var programCorner: ProgramCorner

  public static let `default` = SourceLayout(order: Array(0 ..< SourceIndex.count))

  public init(
    order: [Int] = Array(0 ..< SourceIndex.count),
    programCorner: ProgramCorner = .topLeading
  ) {
    self.order = Self.sanitized(order)
    self.programCorner = programCorner
  }

  /// A layout saved before Output could move has no corner, and one written by a later build may
  /// name a corner this one does not know. Both come back top-left rather than failing the load.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      order: try container.decodeIfPresent([Int].self, forKey: .order) ?? [],
      programCorner: (try? container.decodeIfPresent(ProgramCorner.self, forKey: .programCorner))
        ?? .topLeading
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(order, forKey: .order)
    try container.encode(programCorner, forKey: .programCorner)
  }

  /// Drops duplicates and out-of-range entries, then fills any missing source so the grid always
  /// has exactly the five sources.
  public static func sanitized(_ order: [Int]) -> [Int] {
    var result: [Int] = []
    var used = Set<Int>()
    for value in order where (0 ..< SourceIndex.count).contains(value) && !used.contains(value) {
      result.append(value)
      used.insert(value)
    }
    for value in 0 ..< SourceIndex.count where !used.contains(value) {
      result.append(value)
    }
    return result
  }

  public func sourceIndex(atSlot slot: Int) -> Int {
    guard order.indices.contains(slot) else { return slot }
    return order[slot]
  }

  public func slot(forSource sourceIndex: Int) -> Int {
    order.firstIndex(of: sourceIndex) ?? sourceIndex
  }

  /// Puts `sourceIndex` in `slot` by exchanging with whoever is already there. Dragging across
  /// several tiles is this, once per slot the finger enters.
  public mutating func moveSource(_ sourceIndex: Int, toSlot slot: Int) {
    guard (0 ..< SourceIndex.count).contains(slot) else { return }
    guard (0 ..< SourceIndex.count).contains(sourceIndex) else { return }
    let from = self.slot(forSource: sourceIndex)
    guard from != slot else { return }
    order.swapAt(from, slot)
  }

  /// 1-based source numbers in visual-slot order, for accessibility and dump-state.
  public var displayOrder: String {
    order.map { String($0 + 1) }.joined(separator: ",")
  }

  private enum CodingKeys: String, CodingKey {
    case order
    case programCorner
  }
}

/// Frames of the 3×3 director grid. Output occupies a merged 2×2 in `programCorner`; the five
/// source slots are the remaining cells, in reading order.
public struct SourceGridGeometry: Equatable, Sendable {
  public var size: CGSize
  public var spacing: CGFloat
  public var tileWidth: CGFloat
  public var tileHeight: CGFloat
  public var programFrame: CGRect
  public var slotFrames: [CGRect]

  public init(size: CGSize, spacing: CGFloat = 8, programCorner: ProgramCorner = .topLeading) {
    self.size = size
    self.spacing = spacing
    let tileWidth = (size.width - spacing * 2) / 3
    let tileHeight = (size.height - spacing * 2) / 3
    self.tileWidth = tileWidth
    self.tileHeight = tileHeight
    let cellOrigin = { (column: Int, row: Int) in
      CGPoint(x: CGFloat(column) * (tileWidth + spacing), y: CGFloat(row) * (tileHeight + spacing))
    }
    let programColumn = programCorner.isLeading ? 0 : 1
    let programRow = programCorner.isTop ? 0 : 1
    self.programFrame = CGRect(
      origin: cellOrigin(programColumn, programRow),
      size: CGSize(width: tileWidth * 2 + spacing, height: tileHeight * 2 + spacing)
    )
    var slotFrames: [CGRect] = []
    for row in 0 ..< 3 {
      for column in 0 ..< 3 {
        let inProgram = (programColumn ... programColumn + 1).contains(column)
          && (programRow ... programRow + 1).contains(row)
        guard !inProgram else { continue }
        slotFrames.append(
          CGRect(origin: cellOrigin(column, row), size: CGSize(width: tileWidth, height: tileHeight))
        )
      }
    }
    self.slotFrames = slotFrames
  }

  public func slot(containing point: CGPoint) -> Int? {
    slotFrames.enumerated().first { $0.element.contains(point) }?.offset
  }

  /// The corner of the quadrant `point` is in: where Output lands when its centre is dropped there.
  public func programCorner(nearest point: CGPoint) -> ProgramCorner {
    ProgramCorner(isTop: point.y < size.height / 2, isLeading: point.x < size.width / 2)
  }
}

/// `UserDefaults` persistence for the source-tile order. Independent of which camera occupies a
/// source, and of `SourceSelectionStore`.
public struct SourceLayoutStore: Sendable {
  private static let key = "app.teamstation.director.sourceLayout"
  private let store: ConfigStore

  public init(store: ConfigStore = ConfigStore()) {
    self.store = store
  }

  public func load() -> SourceLayout {
    store.codableValue(SourceLayout.self, forKey: Self.key) ?? .default
  }

  public func save(_ layout: SourceLayout) {
    store.setCodableValue(layout, forKey: Self.key)
  }

  public func clear() {
    store.removeValue(forKey: Self.key)
  }
}
