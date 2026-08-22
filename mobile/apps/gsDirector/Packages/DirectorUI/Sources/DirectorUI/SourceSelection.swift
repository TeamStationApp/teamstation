import Foundation
import DirectorCore
import DirectorSources

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
  /// Input volume for this camera's native audio, 0...1. Fifty percent is unity into the mix;
  /// 100 percent is twice as loud and can clip.
  public var inputGain: Double
  /// Preferred (and, when enabled, occupied) grid slot. Kept when VIDEO is off so re-enable
  /// restores it if that source is free.
  public var sourceIndex: Int?
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
    inputGain: Double = SourceSelectionRules.defaultInputGain,
    sourceIndex: Int? = nil,
    isPresent: Bool = true
  ) {
    self.id = id
    self.kind = kind
    self.advertisedName = advertisedName
    self.customName = customName
    self.isEnabled = isEnabled
    self.usesAudio = usesAudio
    self.inputGain = SourceSelectionRules.clampedInputGain(inputGain)
    self.sourceIndex = sourceIndex
    self.isPresent = isPresent
  }

  enum CodingKeys: String, CodingKey {
    case id, kind, advertisedName, customName, isEnabled, usesAudio, inputGain, sourceIndex, isPresent
    case tileIndex
  }

  /// Selections saved before `usesAudio` existed decode with audio on, matching the old behaviour
  /// where the program source's audio was always taken. Missing `inputGain` is 50 percent, which is
  /// unity. `tileIndex` is the pre-rename slot key.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      id: try container.decode(SourceID.self, forKey: .id),
      kind: try container.decode(SourceKind.self, forKey: .kind),
      advertisedName: try container.decode(String.self, forKey: .advertisedName),
      customName: try container.decodeIfPresent(String.self, forKey: .customName),
      isEnabled: try container.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? false,
      usesAudio: try container.decodeIfPresent(Bool.self, forKey: .usesAudio) ?? true,
      inputGain: try container.decodeIfPresent(Double.self, forKey: .inputGain)
        ?? SourceSelectionRules.defaultInputGain,
      sourceIndex: try container.decodeIfPresent(Int.self, forKey: .sourceIndex)
        ?? container.decodeIfPresent(Int.self, forKey: .tileIndex),
      isPresent: try container.decodeIfPresent(Bool.self, forKey: .isPresent) ?? true
    )
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(kind, forKey: .kind)
    try container.encode(advertisedName, forKey: .advertisedName)
    try container.encodeIfPresent(customName, forKey: .customName)
    try container.encode(isEnabled, forKey: .isEnabled)
    try container.encode(usesAudio, forKey: .usesAudio)
    try container.encode(inputGain, forKey: .inputGain)
    try container.encodeIfPresent(sourceIndex, forKey: .sourceIndex)
    try container.encodeIfPresent(sourceIndex, forKey: .tileIndex)
    try container.encode(isPresent, forKey: .isPresent)
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
  /// ones keep their rename and enabled state. Enabled (or operator-renamed) cameras that vanish
  /// stay as absent rows. Unidentified ghosts are dropped so an IP and a Bonjour uuid for the
  /// same camera cannot both occupy the list.
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

    // Named cameras on a tile stay when they drop off the network. An unidentified IP or UUID
    // hostname that identity later bound to a real camera must not remain as a grey duplicate.
    for var absent in existing where !seen.contains(absent.id) {
      guard absent.isEnabled || !(absent.customName?.isEmpty ?? true) else { continue }
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
    case enabled(sourceIndex: Int)
    case disabled
    case rejectedAtCap
    case unknownSource
  }

  /// Live occupancy: source indexes held by currently enabled cameras.
  public static func occupiedSlots(in selections: [SourceSelection]) -> Set<Int> {
    Set(selections.compactMap { $0.isEnabled ? $0.sourceIndex : nil })
  }

  /// Enabling one past the cap is rejected rather than silently swapping one out — the operator
  /// must decide which camera loses its source.
  @discardableResult
  public static func setEnabled(
    _ enabled: Bool,
    for id: SourceID,
    in selections: inout [SourceSelection]
  ) -> EnableResult {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return .unknownSource }

    if !enabled {
      selections[position].isEnabled = false
      return .disabled
    }
    if selections[position].isEnabled, let slot = selections[position].sourceIndex {
      return .enabled(sourceIndex: slot)
    }

    let used = occupiedSlots(in: selections)
    if let preferred = selections[position].sourceIndex, !used.contains(preferred) {
      selections[position].isEnabled = true
      return .enabled(sourceIndex: preferred)
    }
    guard used.count < maximumEnabled, let free = (0 ..< maximumEnabled).first(where: { !used.contains($0) })
    else { return .rejectedAtCap }

    selections[position].isEnabled = true
    selections[position].sourceIndex = free
    return .enabled(sourceIndex: free)
  }

  public enum AssignResult: Equatable {
    case unchanged
    case applied(reassign: SourceMove?)
    case unknownSource
    case invalidSlot
  }

  public struct SourceMove: Equatable, Sendable {
    public var from: Int
    public var to: Int

    public init(from: Int, to: Int) {
      self.from = from
      self.to = to
    }
  }

  /// Puts `id` on `slot`, swapping with whoever already has that index. Enabled cameras never
  /// lose their slot to `nil`.
  @discardableResult
  public static func assign(
    slot: Int,
    to id: SourceID,
    in selections: inout [SourceSelection]
  ) -> AssignResult {
    guard (0 ..< maximumEnabled).contains(slot) else { return .invalidSlot }
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return .unknownSource }
    let from = selections[position].sourceIndex
    if from == slot { return .unchanged }

    let other = selections.firstIndex(where: { $0.id != id && $0.sourceIndex == slot })
    if let other, selections[other].isEnabled, from == nil {
      let used = occupiedSlots(in: selections)
      guard let park = (0 ..< maximumEnabled).first(where: { $0 != slot && !used.contains($0) })
      else { return .unchanged }
      selections[other].sourceIndex = park
      selections[position].sourceIndex = slot
      return .applied(reassign: SourceMove(from: slot, to: park))
    }
    if let other {
      selections[other].sourceIndex = from
    }
    selections[position].sourceIndex = slot
    if selections[position].isEnabled, let from {
      return .applied(reassign: SourceMove(from: from, to: slot))
    }
    if let other, selections[other].isEnabled, let from {
      return .applied(reassign: SourceMove(from: slot, to: from))
    }
    return .applied(reassign: nil)
  }

  public static func setUsesAudio(
    _ usesAudio: Bool,
    for id: SourceID,
    in selections: inout [SourceSelection]
  ) {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return }
    selections[position].usesAudio = usesAudio
  }

  public static let defaultInputGain: Double = 0.5

  public static func clampedInputGain(_ value: Double) -> Double {
    min(1, max(0, value))
  }

  /// Mix amplitude for a stored gain. 50 percent is 1.0 so the default matches the previous
  /// unscaled camera; 100 percent is 2.0 and will clip a full-scale source.
  public static func mixMultiplier(forGain gain: Double) -> Double {
    clampedInputGain(gain) * 2
  }

  public static func setInputGain(
    _ gain: Double,
    for id: SourceID,
    in selections: inout [SourceSelection]
  ) {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return }
    selections[position].inputGain = clampedInputGain(gain)
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
      .filter { $0.isEnabled && $0.sourceIndex != nil }
      .sorted { ($0.sourceIndex ?? 0) < ($1.sourceIndex ?? 0) }
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
  private static let key = "co.gamestation.director.sources"
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
