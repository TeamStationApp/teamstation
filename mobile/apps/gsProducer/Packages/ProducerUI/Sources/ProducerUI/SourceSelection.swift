import Foundation
import ProducerCore
import ProducerSources

/// A discovered source plus the operator's decisions about it.
public struct SourceSelection: Identifiable, Hashable, Sendable, Codable {
  public var id: SourceID
  public var kind: SourceKind
  public var advertisedName: String
  /// Operator's rename, if any. Persisted across launches.
  public var customName: String?
  public var isEnabled: Bool
  /// Whether this source's audio is mixed into the program output. Independent of `isEnabled`
  /// because the two decisions are genuinely separate: a wide shot may be the picture you never cut
  /// to and the only microphone worth hearing.
  public var usesAudio: Bool
  /// Which grid position it occupies, assigned on enable.
  public var tileIndex: Int?
  /// False once discovery stops seeing it, but the row stays so a rename is not lost when a
  /// camera briefly drops off the network.
  public var isPresent: Bool

  public init(
    id: SourceID,
    kind: SourceKind,
    advertisedName: String,
    customName: String? = nil,
    isEnabled: Bool = false,
    usesAudio: Bool = true,
    tileIndex: Int? = nil,
    isPresent: Bool = true
  ) {
    self.id = id
    self.kind = kind
    self.advertisedName = advertisedName
    self.customName = customName
    self.isEnabled = isEnabled
    self.usesAudio = usesAudio
    self.tileIndex = tileIndex
    self.isPresent = isPresent
  }

  /// Selections saved before `usesAudio` existed decode with audio on, matching the old behaviour
  /// where the program tile's audio was always taken.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      id: try container.decode(SourceID.self, forKey: .id),
      kind: try container.decode(SourceKind.self, forKey: .kind),
      advertisedName: try container.decode(String.self, forKey: .advertisedName),
      customName: try container.decodeIfPresent(String.self, forKey: .customName),
      isEnabled: try container.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? false,
      usesAudio: try container.decodeIfPresent(Bool.self, forKey: .usesAudio) ?? true,
      tileIndex: try container.decodeIfPresent(Int.self, forKey: .tileIndex),
      isPresent: try container.decodeIfPresent(Bool.self, forKey: .isPresent) ?? true
    )
  }

  public var displayName: String {
    let trimmed = customName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let trimmed, !trimmed.isEmpty { return trimmed }
    return advertisedName
  }
}

/// Merge, cap and persistence rules for the source list, kept free of UI so they are unit
/// testable without a simulator.
public enum SourceSelectionRules {
  /// Five source tiles, because the grid is 3×3 with the program preview taking a merged 2×2 block.
  public static let maximumEnabled = 5

  /// Folds a fresh discovery result into the existing list: new sources are appended, known
  /// ones keep their rename and enabled state, and vanished ones are marked absent rather than
  /// deleted.
  public static func merge(
    existing: [SourceSelection],
    discovered: [DiscoveredSource]
  ) -> [SourceSelection] {
    var result: [SourceSelection] = []
    var seen: Set<SourceID> = []

    for source in discovered {
      seen.insert(source.id)
      if var known = existing.first(where: { $0.id == source.id }) {
        known.advertisedName = source.advertisedName
        known.isPresent = true
        result.append(known)
      } else {
        result.append(SourceSelection(
          id: source.id,
          kind: source.kind,
          advertisedName: source.advertisedName
        ))
      }
    }

    for var absent in existing where !seen.contains(absent.id) {
      absent.isPresent = false
      result.append(absent)
    }
    return result
  }

  /// Launch arguments and Settings can switch synthetic ↔ live. Rows of the other kind must not
  /// stay in the list: they look like live cameras and a missing live row would otherwise try
  /// to connect from a leftover address.
  public static func retaining(_ selections: [SourceSelection], kind: SourceKind) -> [SourceSelection] {
    selections.filter { $0.kind == kind }
  }

  public enum EnableResult: Equatable {
    case enabled(tileIndex: Int)
    case disabled
    case rejectedAtCap
    case unknownSource
  }

  /// Enabling one past the cap is rejected rather than silently swapping one out — the operator
  /// must decide which camera loses its tile.
  @discardableResult
  public static func setEnabled(
    _ enabled: Bool,
    for id: SourceID,
    in selections: inout [SourceSelection]
  ) -> EnableResult {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return .unknownSource }

    if !enabled {
      selections[position].isEnabled = false
      selections[position].tileIndex = nil
      return .disabled
    }
    if selections[position].isEnabled, let tile = selections[position].tileIndex {
      return .enabled(tileIndex: tile)
    }

    let used = Set(selections.compactMap { $0.isEnabled ? $0.tileIndex : nil })
    guard used.count < maximumEnabled, let free = (0 ..< maximumEnabled).first(where: { !used.contains($0) })
    else { return .rejectedAtCap }

    selections[position].isEnabled = true
    selections[position].tileIndex = free
    return .enabled(tileIndex: free)
  }

  public static func setUsesAudio(
    _ usesAudio: Bool,
    for id: SourceID,
    in selections: inout [SourceSelection]
  ) {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return }
    selections[position].usesAudio = usesAudio
  }

  /// Sources whose audio belongs in the program mix. A source that is not on a tile contributes
  /// nothing, because it is not being received at all.
  public static func audioContributors(in selections: [SourceSelection]) -> [SourceSelection] {
    enabled(in: selections).filter(\.usesAudio)
  }

  public static func rename(_ name: String?, for id: SourceID, in selections: inout [SourceSelection]) {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return }
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
    selections[position].customName = (trimmed?.isEmpty ?? true) ? nil : trimmed
  }

  public static func enabled(in selections: [SourceSelection]) -> [SourceSelection] {
    selections
      .filter { $0.isEnabled && $0.tileIndex != nil }
      .sorted { ($0.tileIndex ?? 0) < ($1.tileIndex ?? 0) }
  }

  /// A camera the scanner has not published has no stream to open. Starting it anyway is what
  /// produced "no stream address" toasts at launch for cameras that were simply still off.
  public static func startableSource(
    id: SourceID,
    among discovered: [DiscoveredSource]
  ) -> DiscoveredSource? {
    discovered.first { $0.id == id }
  }
}

/// Operator-facing camera failures. A camera that is not on the network at launch is not an
/// error — it simply is not shown. The same failure during a recording is: that take is lost.
public enum OperatorAlert {
  public static func cameraFailure(
    displayName: String,
    detail: String,
    isRecording: Bool
  ) -> String? {
    guard isRecording, !detail.isEmpty else { return nil }
    return "\(displayName) went offline: \(detail)"
  }
}

/// `UserDefaults` persistence for the selection list.
public struct SourceSelectionStore: Sendable {
  private static let key = "co.gamestation.producer.sources"
  private let store: ConfigStore

  public init(store: ConfigStore = ConfigStore()) {
    self.store = store
  }

  public func load() -> [SourceSelection] {
    store.codableValue([SourceSelection].self, forKey: Self.key) ?? []
  }

  public func save(_ selections: [SourceSelection]) {
    store.setCodableValue(selections, forKey: Self.key)
  }

  public func clear() {
    store.removeValue(forKey: Self.key)
  }
}
