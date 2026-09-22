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
  ///
  /// Off until the operator asks for it. Which microphones are in the programme is a decision
  /// somebody makes once and expects to hold, and a camera arriving in the mix unasked is how a
  /// crowd, a dugout or a phone left face-down on a table gets into a game nobody was listening to
  /// at the time. See `SourceAudioRules` for how that decision then outlives the row it was made on.
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
  /// The camera whose parameter channel drives this row's tile — telemetry and remote control,
  /// never a media session. Set on the row that has the picture (an NDI capture of a phone's HDMI,
  /// say); the phone it names is taken off the grid and listed directly under this row.
  public var linkedControlID: SourceID?

  public init(
    id: SourceID,
    kind: SourceKind,
    advertisedName: String,
    customName: String? = nil,
    isEnabled: Bool = false,
    usesAudio: Bool = false,
    inputGain: Double = SourceSelectionRules.defaultInputGain,
    sourceIndex: Int? = nil,
    isPresent: Bool = true,
    linkedControlID: SourceID? = nil
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
    self.linkedControlID = linkedControlID
  }

  enum CodingKeys: String, CodingKey {
    case id, kind, advertisedName, customName, isEnabled, usesAudio, inputGain, sourceIndex, isPresent
    case tileIndex, linkedControlID
  }

  /// Selections saved before `usesAudio` existed decode with audio on — not off, as a camera
  /// discovered today does. They are an iPad that was already mixing those cameras, back when the
  /// program source's audio was always taken, and an upgrade must not silence a rig mid-season.
  /// Missing `inputGain` is 50 percent, which is unity. `tileIndex` is the pre-rename slot key.
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
      isPresent: try container.decodeIfPresent(Bool.self, forKey: .isPresent) ?? true,
      linkedControlID: try container.decodeIfPresent(SourceID.self, forKey: .linkedControlID)
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
    try container.encodeIfPresent(linkedControlID, forKey: .linkedControlID)
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
  /// stay as absent rows. Address-keyed ghosts are dropped so an IP cannot occupy the list after
  /// identity bound the same camera to a real record.
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

    // Named cameras on a tile stay when they drop off the network, and so does either half of a
    // link: a phone that is off tonight is still the phone that controls that tile. An
    // address-keyed row that identity later bound to a real camera must not remain as a grey
    // duplicate.
    let controls = linkedControlIDs(in: existing)
    for var absent in existing where !seen.contains(absent.id) {
      guard !CameraIdentityRules.isAddressKeyedSourceID(absent.id) else { continue }
      let linked = absent.linkedControlID != nil || controls.contains(absent.id)
      guard absent.isEnabled || linked || !(absent.customName?.isEmpty ?? true) else { continue }
      absent.isPresent = false
      result.append(absent)
    }
    return result
  }

  /// Re-merges only the kinds a refresh actually covered, leaving every other transport's rows
  /// exactly as they were.
  ///
  /// `merge` treats its list as the whole truth: anything missing becomes absent, and an unnamed
  /// disabled row is dropped outright. That is right for a discovery publishing everything it can
  /// see, and wrong for a republish that only one transport can answer. Endpoint identity is an
  /// RTSP concern — NDI cameras are keyed by name and have no endpoint to rebind — so a rebinding
  /// pass sent through the full merge marked every NDI camera missing and deleted the ones nobody
  /// had enabled yet.
  ///
  /// Existing rows keep their order, so nothing moves to another tile because of a refresh.
  public static func merging(
    existing: [SourceSelection],
    discovered: [DiscoveredSource],
    limitedTo kinds: Set<SourceKind>
  ) -> [SourceSelection] {
    guard !kinds.isEmpty else { return existing }
    let untouched = existing.filter { !kinds.contains($0.kind) }
    let refreshed = merge(
      existing: existing.filter { kinds.contains($0.kind) },
      discovered: discovered.filter { kinds.contains($0.kind) }
    ).filter { $0.isPresent || $0.isEnabled }

    var rank: [SourceID: Int] = [:]
    for (offset, selection) in existing.enumerated() where rank[selection.id] == nil {
      rank[selection.id] = offset
    }
    return (untouched + refreshed)
      .enumerated()
      .sorted { lhs, rhs in
        let left = rank[lhs.element.id] ?? (existing.count + lhs.offset)
        let right = rank[rhs.element.id] ?? (existing.count + rhs.offset)
        return left < right
      }
      .map(\.element)
  }

  /// Synthetic and file rows persist. RTSP only persists when the SourceID is a CameraRecord UUID.
  /// An NDI row always persists: its SourceID is derived from the camera's own NDI name rather
  /// than from an address, so it survives the camera moving and is meaningful again next launch.
  public static func isPersistable(_ selection: SourceSelection) -> Bool {
    switch selection.kind {
    case .synthetic, .file, .ndi:
      return true
    case .rtsp:
      return CameraIdentityRules.isHardenedSourceID(selection.id)
    }
  }

  /// Launch arguments and Settings can switch synthetic ↔ live. Rows of the other kind must not
  /// stay in the list: they look like live cameras and a missing live row would otherwise try
  /// to connect from a leftover address.
  ///
  /// The live transports are not exclusive of each other, though, and treating them as such is
  /// what made a mixed session impossible: both NDI selections were discarded the moment RTSP
  /// discovery started. So the boundary that prunes is generated against live, and one generated
  /// kind against the other — never NDI against RTSP.
  public static func retaining(_ selections: [SourceSelection], kind: SourceKind) -> [SourceSelection] {
    guard kind.isLive else { return selections.filter { $0.kind == kind } }
    return selections.filter(\.kind.isLive)
  }

  public enum EnableResult: Equatable {
    /// The row is another row's control link; it has no picture of its own to put on a tile.
    case linkedForControl
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
    if isLinkedControl(id, in: selections) { return .linkedForControl }
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
    guard !isLinkedControl(id, in: selections) else { return .unchanged }
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

  /// Turns one camera's audio on, and every other camera's off.
  ///
  /// A take has one source for sound. The programme master places its sound by one offset settled
  /// at the part's start, which is only correct while the sound comes from one place: summing
  /// several meant the mix could not emit a moment until the *last* contributor's audio for it had
  /// landed, and the writer was left reconciling two independently-timed streams after the fact.
  /// That reconciliation is what cost takes 413 and 414 forty-four and forty-seven seconds of
  /// sound. See `ProgramSoundCheck` and the `programmeSoundLock` plan.
  ///
  /// The control stays a toggle, because that is what the operator already reaches for; turning one
  /// on is what turns the others off. Turning the only one *off* leaves the take with no sound,
  /// which is a thing an operator may legitimately want, so it is allowed.
  public static func setUsesAudio(
    _ usesAudio: Bool,
    for id: SourceID,
    in selections: inout [SourceSelection]
  ) {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return }
    guard !isLinkedControl(id, in: selections) else { return }
    selections[position].usesAudio = usesAudio
    guard usesAudio else { return }
    for other in selections.indices where other != position {
      selections[other].usesAudio = false
    }
  }

  /// The one source carrying this take's sound, if any.
  public static func audioSource(in selections: [SourceSelection]) -> SourceSelection? {
    audioContributors(in: selections).first
  }

  /// Leaves at most one row's audio on: the one the operator most recently chose.
  ///
  /// Needed because remembered audio settings are filed per camera, and every take up to 409
  /// remembered three cameras with audio on. Restoring those verbatim would put a sum back on a
  /// build whose programme master is only correct with one source.
  ///
  /// `chosenAt` breaks the tie, and it has to. An earlier cut of this kept the first row instead,
  /// on the grounds that row order is stable — and on the bench rig that quietly took the audio
  /// from `1st`, which hears the clapperboard, and gave it to `3rd`, which barely does, so a
  /// thirty-minute soak measured the wrong microphone. Stability is worth nothing if the stable
  /// answer is not the operator's. Rows with no stamp are older than the stamp and lose to any
  /// row that has one; with no stamps anywhere, row order still decides.
  public static func normalisingAudioToOne(
    _ selections: [SourceSelection],
    chosenAt: [SourceID: Double] = [:]
  ) -> [SourceSelection] {
    let candidates = selections.filter(\.usesAudio)
    guard candidates.count > 1 else { return selections }
    let keep = candidates.enumerated().max {
      (chosenAt[$0.element.id] ?? -.infinity, -Double($0.offset))
        < (chosenAt[$1.element.id] ?? -.infinity, -Double($1.offset))
    }?.element.id
    return selections.map { selection in
      guard selection.usesAudio, selection.id != keep else { return selection }
      var off = selection
      off.usesAudio = false
      return off
    }
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

  /// Slot that should be Output: the persisted camera if it is still on a tile, otherwise the
  /// last enabled camera in list order (the one the operator most recently turned on, once
  /// `preferredID` is updated on each enable).
  public static func programSourceIndex(
    preferring preferredID: SourceID?,
    among selections: [SourceSelection]
  ) -> Int? {
    let live = selections.filter { $0.isEnabled && $0.sourceIndex != nil }
    if let preferredID, let match = live.first(where: { $0.id == preferredID }) {
      return match.sourceIndex
    }
    return live.last?.sourceIndex
  }

  // MARK: - Linking

  public enum LinkResult: Equatable {
    case linked
    case unknownSource
    case sameSource
    /// The phone is already the control for another row, or has a link of its own.
    case controlAlreadyLinked
    /// The row asked to carry the picture is itself somebody's control.
    case videoIsControl
  }

  /// Every row that is currently serving as another row's control.
  public static func linkedControlIDs(in selections: [SourceSelection]) -> Set<SourceID> {
    Set(selections.compactMap(\.linkedControlID))
  }

  public static func isLinkedControl(_ id: SourceID, in selections: [SourceSelection]) -> Bool {
    selections.contains { $0.linkedControlID == id }
  }

  /// The row whose picture `id` controls, when `id` is a linked control.
  public static func linkedVideoID(forControl id: SourceID, in selections: [SourceSelection]) -> SourceID? {
    selections.first { $0.linkedControlID == id }?.id
  }

  /// Points `video`'s tile at `control`'s parameter channel. The phone leaves the grid: no tile, no
  /// slot, no place in the mix, and `setEnabled` refuses it while the link stands. Nothing but the
  /// parameter channel is ever opened to it, which is what keeps its radio and encoder quiet.
  @discardableResult
  public static func link(
    video: SourceID,
    control: SourceID,
    in selections: inout [SourceSelection]
  ) -> LinkResult {
    guard video != control else { return .sameSource }
    guard let videoPosition = selections.firstIndex(where: { $0.id == video }),
          let controlPosition = selections.firstIndex(where: { $0.id == control })
    else { return .unknownSource }
    guard !isLinkedControl(video, in: selections) else { return .videoIsControl }
    if let owner = linkedVideoID(forControl: control, in: selections), owner != video {
      return .controlAlreadyLinked
    }
    guard selections[controlPosition].linkedControlID == nil else { return .controlAlreadyLinked }

    selections[videoPosition].linkedControlID = control
    selections[controlPosition].isEnabled = false
    selections[controlPosition].sourceIndex = nil
    selections[controlPosition].usesAudio = false
    return .linked
  }

  /// Breaks the link from the phone's side (the red X on its row). The phone becomes an ordinary
  /// disabled row the operator can turn on again.
  public static func unlink(control id: SourceID, in selections: inout [SourceSelection]) {
    for position in selections.indices where selections[position].linkedControlID == id {
      selections[position].linkedControlID = nil
    }
  }

  /// Breaks the link from the picture's side.
  public static func unlink(video id: SourceID, in selections: inout [SourceSelection]) {
    guard let position = selections.firstIndex(where: { $0.id == id }) else { return }
    selections[position].linkedControlID = nil
  }

  /// Rows the picker may offer `video`: controllable, not the row itself, and not spoken for —
  /// except by `video`, whose current partner stays in the list so the picker can mark it.
  public static func linkCandidates(
    for video: SourceID,
    in selections: [SourceSelection],
    controllable: (SourceSelection) -> Bool
  ) -> [SourceSelection] {
    guard !isLinkedControl(video, in: selections) else { return [] }
    return selections.filter { candidate in
      guard candidate.id != video, controllable(candidate), candidate.linkedControlID == nil else { return false }
      let owner = linkedVideoID(forControl: candidate.id, in: selections)
      return owner == nil || owner == video
    }
  }

  /// The list as the operator reads it: each linked phone directly under the row it controls.
  /// The stored order is untouched, so slots, `merge` and the control channel's row numbers are
  /// unaffected; only the picture on screen changes.
  public static func displayOrder(_ selections: [SourceSelection]) -> [SourceSelection] {
    let controls = linkedControlIDs(in: selections)
    var ordered: [SourceSelection] = []
    for selection in selections where !controls.contains(selection.id) {
      ordered.append(selection)
      if let control = selection.linkedControlID,
         let partner = selections.first(where: { $0.id == control }) {
        ordered.append(partner)
      }
    }
    return ordered
  }

  /// Applied to what the store hands back. A linked phone that still holds a slot — state saved
  /// before the rule, or edited by hand — would otherwise open a media session at launch, and a
  /// link to a row that was never persisted has nothing to point at.
  public static func normalizingLinks(_ selections: [SourceSelection]) -> [SourceSelection] {
    let ids = Set(selections.map(\.id))
    var result = selections
    for position in result.indices {
      if let control = result[position].linkedControlID, !ids.contains(control) {
        result[position].linkedControlID = nil
      }
    }
    let controls = linkedControlIDs(in: result)
    for position in result.indices where controls.contains(result[position].id) {
      result[position].isEnabled = false
      result[position].sourceIndex = nil
      result[position].usesAudio = false
    }
    return result
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

/// Last camera put on Output. Survives reboot so the programme tile comes back on that source.
public struct ProgramSourceStore: Sendable {
  private static let key = "co.gamestation.director.programSource"
  private let store: ConfigStore

  public init(store: ConfigStore = ConfigStore()) {
    self.store = store
  }

  public func load() -> SourceID? {
    store.codableValue(SourceID.self, forKey: Self.key)
  }

  public func save(_ id: SourceID) {
    store.setCodableValue(id, forKey: Self.key)
  }

  public func clear() {
    store.removeValue(forKey: Self.key)
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
    let loaded = store.codableValue([SourceSelection].self, forKey: Self.key) ?? []
    var seen: Set<SourceID> = []
    return loaded.filter { SourceSelectionRules.isPersistable($0) && seen.insert($0.id).inserted }
  }

  public func save(_ selections: [SourceSelection]) {
    store.setCodableValue(
      selections.filter { SourceSelectionRules.isPersistable($0) },
      forKey: Self.key
    )
  }

  public func clear() {
    store.removeValue(forKey: Self.key)
  }
}
