import Foundation

/// Kind of GameController-extended pad a template is authored against.
public enum RemoteType: String, Sendable, Codable, CaseIterable, Identifiable {
  case dualSense
  case dualShock
  case xbox
  case switchPro
  case mfi
  case hidGeneric

  public var id: String { rawValue }

  public var displayName: String {
    switch self {
    case .dualSense: "DualSense"
    case .dualShock: "DualShock"
    case .xbox: "Xbox"
    case .switchPro: "Switch Pro"
    case .mfi: "MFi"
    case .hidGeneric: "Generic"
    }
  }

  /// Controls this type is documented to expose. Extra HID buttons still record at capture time.
  public var supportedControls: Set<ControlID> {
    var ids = ControlID.canonical
    switch self {
    case .dualSense, .dualShock:
      ids.insert(.touchpadButton)
    case .xbox:
      ids.formUnion([ .share, .paddle1, .paddle2, .paddle3, .paddle4 ])
    case .switchPro, .mfi, .hidGeneric:
      break
    }
    return ids
  }
}

/// One digitalized pad control. Analog sticks split into four directions; triggers become buttons.
public enum ControlID: String, Sendable, Codable, Hashable, CaseIterable, Identifiable {
  case a, b, x, y
  case dpadUp, dpadDown, dpadLeft, dpadRight
  case l1, r1, l2, r2, l3, r3
  case leftStickUp, leftStickDown, leftStickLeft, leftStickRight
  case rightStickUp, rightStickDown, rightStickLeft, rightStickRight
  case menu, options, share, home, touchpadButton
  case paddle1, paddle2, paddle3, paddle4

  public var id: String { rawValue }

  public static let canonical: Set<ControlID> = [
    .a, .b, .x, .y,
    .dpadUp, .dpadDown, .dpadLeft, .dpadRight,
    .l1, .r1, .l2, .r2, .l3, .r3,
    .leftStickUp, .leftStickDown, .leftStickLeft, .leftStickRight,
    .rightStickUp, .rightStickDown, .rightStickLeft, .rightStickRight,
    .menu, .options
  ]

  public var pillTitle: String {
    switch self {
    case .a: "A"
    case .b: "B"
    case .x: "X"
    case .y: "Y"
    case .dpadUp: "d-pad"
    case .dpadDown: "d-pad"
    case .dpadLeft: "d-pad"
    case .dpadRight: "d-pad"
    case .l1: "L1"
    case .r1: "R1"
    case .l2: "L2"
    case .r2: "R2"
    case .l3: "L3"
    case .r3: "R3"
    case .leftStickUp, .leftStickDown, .leftStickLeft, .leftStickRight: "L-stick"
    case .rightStickUp, .rightStickDown, .rightStickLeft, .rightStickRight: "R-stick"
    case .menu: "Menu"
    case .options: "Options"
    case .share: "Share"
    case .home: "Home"
    case .touchpadButton: "Touchpad"
    case .paddle1: "P1"
    case .paddle2: "P2"
    case .paddle3: "P3"
    case .paddle4: "P4"
    }
  }

  public var pillSymbol: String {
    switch self {
    case .dpadUp, .leftStickUp, .rightStickUp: "arrow.up"
    case .dpadDown, .leftStickDown, .rightStickDown: "arrow.down"
    case .dpadLeft, .leftStickLeft, .rightStickLeft: "arrow.left"
    case .dpadRight, .leftStickRight, .rightStickRight: "arrow.right"
    default: ""
    }
  }

  /// D-pad and each analog stick can contribute at most one direction to a chord.
  public var exclusiveGroup: ControlExclusiveGroup? {
    switch self {
    case .dpadUp, .dpadDown, .dpadLeft, .dpadRight: .dpad
    case .leftStickUp, .leftStickDown, .leftStickLeft, .leftStickRight: .leftStick
    case .rightStickUp, .rightStickDown, .rightStickLeft, .rightStickRight: .rightStick
    default: nil
    }
  }
}

public enum ControlExclusiveGroup: Sendable, Equatable {
  case dpad
  case leftStick
  case rightStick
}

public enum ReplaySpeed: String, Sendable, Codable, Hashable {
  case full
  case slow
}

/// One director action a chord can fire. Source indexes are 0-based slots.
public enum RemoteAction: Sendable, Codable, Hashable, Identifiable {
  case cutLive(Int)
  case instantReplay(source: Int, seconds: Double, speed: ReplaySpeed)

  public var id: String {
    switch self {
    case let .cutLive(source): "live-\(source)"
    case let .instantReplay(source, seconds, speed):
      "replay-\(source)-\(Self.secondsToken(seconds))-\(speed.rawValue)"
    }
  }

  private static func secondsToken(_ seconds: Double) -> String {
    seconds == seconds.rounded() ? String(Int(seconds)) : String(format: "%g", seconds)
  }

  public var sourceIndex: Int {
    switch self {
    case let .cutLive(source): source
    case let .instantReplay(source, _, _): source
    }
  }

  public func title(slowMotionPercent: Double) -> String {
    editorTargetLabel(slowMotionPercent: slowMotionPercent)
  }

  public func editorTargetLabel(slowMotionPercent: Double) -> String {
    switch self {
    case .cutLive:
      return "source\(sourceIndex + 1):live"
    case let .instantReplay(_, seconds, speed):
      let amount = seconds == seconds.rounded() ? String(Int(seconds)) : String(format: "%g", seconds)
      let base = "rewind \(amount) seconds"
      if speed == .full { return base }
      return "\(base) ×\(Int((slowMotionPercent * 100).rounded()))%"
    }
  }

  public var editorRoleLabel: String {
    switch self {
    case .cutLive: "primary"
    case .instantReplay: "modifier"
    }
  }

  public var accessibilitySuffix: String { id }

  /// Control-channel form: `live-2`, `replay-2-5-full`, `replay-2-7.5-slow` (1-based source).
  public static func parseControl(_ raw: String) -> RemoteAction? {
    let parts = raw.lowercased().split(separator: "-").map(String.init)
    guard let kind = parts.first else { return nil }
    if kind == "live", parts.count == 2, let number = Int(parts[1]), let index = SourceIndex(number - 1) {
      return .cutLive(index.value)
    }
    if kind == "replay", parts.count == 4,
       let number = Int(parts[1]), let index = SourceIndex(number - 1),
       let seconds = Double(parts[2]),
       let speed = ReplaySpeed(rawValue: parts[3]) {
      return .instantReplay(source: index.value, seconds: seconds, speed: speed)
    }
    return nil
  }
}

public enum RemoteActionCatalog {
  public static let replayOffsets: [Double] = [ 5, 7.5, 10 ]

  public static var rewindKinds: [(seconds: Double, speed: ReplaySpeed)] {
    replayOffsets.map { ($0, ReplaySpeed.full) } + replayOffsets.map { ($0, .slow) }
  }

  public static func actions(for source: Int) -> [RemoteAction] {
    let live = [ RemoteAction.cutLive(source) ]
    let full = replayOffsets.map {
      RemoteAction.instantReplay(source: source, seconds: $0, speed: .full)
    }
    let slow = replayOffsets.map {
      RemoteAction.instantReplay(source: source, seconds: $0, speed: .slow)
    }
    return live + full + slow
  }

  /// Five primaries, then the six shared rewind modifiers.
  public static let editorActions: [RemoteAction] = {
    let primaries = (0 ..< SourceIndex.count).map { RemoteAction.cutLive($0) }
    let modifiers = rewindKinds.map {
      RemoteAction.instantReplay(source: 0, seconds: $0.seconds, speed: $0.speed)
    }
    return primaries + modifiers
  }()

  public static let all: [RemoteAction] = {
    (0 ..< SourceIndex.count).flatMap { actions(for: $0) }
  }()
}

public struct RemoteChord: Sendable, Codable, Hashable {
  public var controls: [ControlID]

  public init(controls: [ControlID] = []) {
    self.controls = []
    for id in controls { append(id) }
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let raw = try container.decode([ControlID].self, forKey: .controls)
    self.controls = []
    for id in raw { append(id) }
  }

  public var set: Set<ControlID> { Set(controls) }
  public var isEmpty: Bool { controls.isEmpty }

  public mutating func append(_ id: ControlID) {
    if let group = id.exclusiveGroup {
      controls.removeAll { $0.exclusiveGroup == group }
    } else if controls.contains(id) {
      return
    }
    controls.append(id)
  }

  public mutating func clear() {
    controls = []
  }

  private enum CodingKeys: String, CodingKey { case controls }
}

public struct RemoteBinding: Sendable, Codable, Hashable, Identifiable {
  public var action: RemoteAction
  public var chord: RemoteChord

  public var id: String { action.id }

  public init(action: RemoteAction, chord: RemoteChord = RemoteChord()) {
    self.action = action
    self.chord = chord
  }
}

public struct RemoteControlTemplate: Sendable, Codable, Identifiable, Hashable {
  public static let defaultName = "default remote"

  public var id: UUID
  public var name: String
  public var remoteType: RemoteType
  public var bindings: [RemoteBinding]
  public var lastSeenProductName: String

  public init(
    id: UUID = UUID(),
    name: String,
    remoteType: RemoteType = .hidGeneric,
    bindings: [RemoteBinding] = [],
    lastSeenProductName: String = ""
  ) {
    self.id = id
    self.name = name
    self.remoteType = remoteType
    self.bindings = bindings
    self.lastSeenProductName = lastSeenProductName
  }

  public func chord(for action: RemoteAction) -> RemoteChord {
    bindings.first { $0.action == action }?.chord ?? RemoteChord()
  }
}

public struct RemoteControlManifest: Sendable, Codable, Hashable {
  public var templates: [RemoteControlTemplate]
  public var activeTemplateID: UUID

  public init(templates: [RemoteControlTemplate], activeTemplateID: UUID) {
    self.templates = templates
    self.activeTemplateID = activeTemplateID
  }

  public static func emptyDefault() -> RemoteControlManifest {
    let id = UUID()
    return RemoteControlManifest(
      templates: [ RemoteControlTemplate(id: id, name: RemoteControlTemplate.defaultName) ],
      activeTemplateID: id
    )
  }
}

public enum RemoteDigitalizer {
  public static let stickDeadzone: Float = 0.5
  public static let triggerThreshold: Float = 0.75

  public static func stick(x: Float, y: Float, left: Bool) -> ControlID? {
    let ax = abs(x)
    let ay = abs(y)
    guard max(ax, ay) >= stickDeadzone else { return nil }
    if ax >= ay {
      if x < 0 { return left ? .leftStickLeft : .rightStickLeft }
      return left ? .leftStickRight : .rightStickRight
    }
    if y > 0 { return left ? .leftStickUp : .rightStickUp }
    return left ? .leftStickDown : .rightStickDown
  }

  public static func triggerPressed(_ value: Float) -> Bool {
    value >= triggerThreshold
  }
}

public enum RemoteChordRules {
  /// Largest eligible chord that is a subset of `pressed`. Live needs one button; rewind needs two.
  public static func match(
    pressed: Set<ControlID>,
    bindings: [RemoteBinding]
  ) -> RemoteAction? {
    bindings
      .filter { binding in
        !binding.chord.isEmpty
          && binding.chord.set.isSubset(of: pressed)
          && binding.chord.controls.count == requiredCount(binding.action)
      }
      .max { lhs, rhs in lhs.chord.controls.count < rhs.chord.controls.count }?
      .action
  }

  private static func requiredCount(_ action: RemoteAction) -> Int {
    switch action {
    case .cutLive: 1
    case .instantReplay: 2
    }
  }

  public static func primary(source: Int, in bindings: [RemoteBinding]) -> ControlID? {
    bindings.first { $0.action == .cutLive(source) }?.chord.controls.first
  }

  public static func modifier(for action: RemoteAction, in bindings: [RemoteBinding]) -> ControlID? {
    guard case .instantReplay = action else { return nil }
    let controls = bindings.first { $0.action == action }?.chord.controls ?? []
    guard let first = controls.first else { return nil }
    if let primary = primary(source: action.sourceIndex, in: bindings) {
      return controls.first { $0 != primary }
    }
    return first
  }

  public static func fieldControl(for action: RemoteAction, in bindings: [RemoteBinding]) -> ControlID? {
    switch action {
    case let .cutLive(source): primary(source: source, in: bindings)
    case let .instantReplay(_, seconds, speed):
      globalModifier(seconds: seconds, speed: speed, in: bindings)
    }
  }

  public static func globalModifier(
    seconds: Double,
    speed: ReplaySpeed,
    in bindings: [RemoteBinding]
  ) -> ControlID? {
    for source in 0 ..< SourceIndex.count {
      let action = RemoteAction.instantReplay(source: source, seconds: seconds, speed: speed)
      if let modifier = modifier(for: action, in: bindings) { return modifier }
    }
    return nil
  }

  public static func capture(
    _ id: ControlID,
    for action: RemoteAction,
    in bindings: inout [RemoteBinding]
  ) {
    switch action {
    case let .cutLive(source): setPrimary(id, source: source, in: &bindings)
    case .instantReplay: setModifier(id, for: action, in: &bindings)
    }
  }

  public static func setPrimary(
    _ id: ControlID,
    source: Int,
    in bindings: inout [RemoteBinding]
  ) {
    let modifiers = snapshotModifiers(in: bindings)
    for kind in RemoteActionCatalog.rewindKinds {
      if modifiers[kindKey(kind)] == id {
        clearModifierKind(seconds: kind.seconds, speed: kind.speed, in: &bindings)
      }
    }
    for other in 0 ..< SourceIndex.count where other != source {
      if primary(source: other, in: bindings) == id {
        clearPrimary(source: other, in: &bindings)
      }
    }
    let remaining = snapshotModifiers(in: bindings)
    upsert(.cutLive(source), controls: [ id ], in: &bindings)
    applyModifiers(remaining, to: source, primary: id, in: &bindings)
  }

  public static func setModifier(
    _ id: ControlID,
    for action: RemoteAction,
    in bindings: inout [RemoteBinding]
  ) {
    guard case let .instantReplay(_, seconds, speed) = action else { return }
    if (0 ..< SourceIndex.count).contains(where: { primary(source: $0, in: bindings) == id }) {
      return
    }
    for kind in RemoteActionCatalog.rewindKinds {
      if kind.seconds == seconds && kind.speed == speed { continue }
      if globalModifier(seconds: kind.seconds, speed: kind.speed, in: bindings) == id {
        clearModifierKind(seconds: kind.seconds, speed: kind.speed, in: &bindings)
      }
    }
    writeModifier(id, seconds: seconds, speed: speed, in: &bindings)
  }

  public static func clearPrimary(source: Int, in bindings: inout [RemoteBinding]) {
    let modifiers = snapshotModifiers(in: bindings)
    bindings.removeAll { $0.action == .cutLive(source) }
    applyModifiers(modifiers, to: source, primary: nil, in: &bindings)
  }

  public static func clearModifier(for action: RemoteAction, in bindings: inout [RemoteBinding]) {
    guard case let .instantReplay(_, seconds, speed) = action else { return }
    clearModifierKind(seconds: seconds, speed: speed, in: &bindings)
  }

  public static func clear(action: RemoteAction, in bindings: inout [RemoteBinding]) {
    switch action {
    case let .cutLive(source): clearPrimary(source: source, in: &bindings)
    case .instantReplay: clearModifier(for: action, in: &bindings)
    }
  }

  /// Record `id` on `action` using primary/modifier capture.
  public static func append(
    _ id: ControlID,
    to action: RemoteAction,
    in bindings: inout [RemoteBinding]
  ) {
    capture(id, for: action, in: &bindings)
  }

  public static func bind(
    _ action: RemoteAction,
    controls: [ControlID],
    in bindings: inout [RemoteBinding]
  ) {
    switch action {
    case let .cutLive(source):
      if let id = controls.last { setPrimary(id, source: source, in: &bindings) }
    case .instantReplay:
      if controls.count >= 2 {
        setPrimary(controls[0], source: action.sourceIndex, in: &bindings)
        setModifier(controls[1], for: action, in: &bindings)
      } else if let id = controls.first {
        setModifier(id, for: action, in: &bindings)
      }
    }
  }

  public static func normalize(_ bindings: [RemoteBinding]) -> [RemoteBinding] {
    var primaries: [Int: ControlID] = [:]
    var used: Set<ControlID> = []
    for source in 0 ..< SourceIndex.count {
      guard let id = bindings.first(where: { $0.action == .cutLive(source) })?.chord.controls.first
      else { continue }
      if used.contains(id) { continue }
      used.insert(id)
      primaries[source] = id
    }
    var modifiers: [String: ControlID] = [:]
    for kind in RemoteActionCatalog.rewindKinds {
      let key = kindKey(kind)
      for source in 0 ..< SourceIndex.count {
        let action = RemoteAction.instantReplay(
          source: source,
          seconds: kind.seconds,
          speed: kind.speed
        )
        let controls = bindings.first { $0.action == action }?.chord.controls ?? []
        let candidate: ControlID?
        if let primary = primaries[source] {
          candidate = controls.first { $0 != primary }
        } else {
          candidate = controls.first
        }
        guard let candidate, !used.contains(candidate), !modifiers.values.contains(candidate) else {
          continue
        }
        modifiers[key] = candidate
        break
      }
    }
    var result: [RemoteBinding] = []
    for source in 0 ..< SourceIndex.count {
      if let primary = primaries[source] {
        result.append(RemoteBinding(action: .cutLive(source), chord: RemoteChord(controls: [ primary ])))
      }
      for kind in RemoteActionCatalog.rewindKinds {
        guard let modifier = modifiers[kindKey(kind)] else { continue }
        let action = RemoteAction.instantReplay(
          source: source,
          seconds: kind.seconds,
          speed: kind.speed
        )
        if let primary = primaries[source] {
          result.append(RemoteBinding(action: action, chord: RemoteChord(controls: [ primary, modifier ])))
        } else {
          result.append(RemoteBinding(action: action, chord: RemoteChord(controls: [ modifier ])))
        }
      }
    }
    return result
  }

  public static func bestFit(
    bindings: [RemoteBinding],
    to type: RemoteType
  ) -> (kept: [RemoteBinding], dropped: Int) {
    let allowed = type.supportedControls
    var dropped = 0
    var kept: [RemoteBinding] = []
    for binding in bindings {
      let remaining = binding.chord.controls.filter { allowed.contains($0) }
      dropped += binding.chord.controls.count - remaining.count
      if remaining.isEmpty { continue }
      kept.append(RemoteBinding(action: binding.action, chord: RemoteChord(controls: remaining)))
    }
    return (normalize(kept), dropped)
  }

  private static func snapshotModifiers(in bindings: [RemoteBinding]) -> [String: ControlID] {
    var result: [String: ControlID] = [:]
    for kind in RemoteActionCatalog.rewindKinds {
      if let modifier = globalModifier(seconds: kind.seconds, speed: kind.speed, in: bindings) {
        result[kindKey(kind)] = modifier
      }
    }
    return result
  }

  private static func applyModifiers(
    _ modifiers: [String: ControlID],
    to source: Int,
    primary: ControlID?,
    in bindings: inout [RemoteBinding]
  ) {
    for kind in RemoteActionCatalog.rewindKinds {
      let action = RemoteAction.instantReplay(
        source: source,
        seconds: kind.seconds,
        speed: kind.speed
      )
      guard let modifier = modifiers[kindKey(kind)], modifier != primary else {
        bindings.removeAll { $0.action == action }
        continue
      }
      if let primary {
        upsert(action, controls: [ primary, modifier ], in: &bindings)
      } else {
        upsert(action, controls: [ modifier ], in: &bindings)
      }
    }
  }

  private static func writeModifier(
    _ id: ControlID,
    seconds: Double,
    speed: ReplaySpeed,
    in bindings: inout [RemoteBinding]
  ) {
    for source in 0 ..< SourceIndex.count {
      let action = RemoteAction.instantReplay(source: source, seconds: seconds, speed: speed)
      if let primary = primary(source: source, in: bindings), primary != id {
        upsert(action, controls: [ primary, id ], in: &bindings)
      } else {
        upsert(action, controls: [ id ], in: &bindings)
      }
    }
  }

  private static func clearModifierKind(
    seconds: Double,
    speed: ReplaySpeed,
    in bindings: inout [RemoteBinding]
  ) {
    for source in 0 ..< SourceIndex.count {
      let action = RemoteAction.instantReplay(source: source, seconds: seconds, speed: speed)
      bindings.removeAll { $0.action == action }
    }
  }

  private static func kindKey(_ kind: (seconds: Double, speed: ReplaySpeed)) -> String {
    "\(kind.seconds)-\(kind.speed.rawValue)"
  }

  private static func upsert(
    _ action: RemoteAction,
    controls: [ControlID],
    in bindings: inout [RemoteBinding]
  ) {
    let chord = RemoteChord(controls: controls)
    if chord.isEmpty {
      bindings.removeAll { $0.action == action }
      return
    }
    if let index = bindings.firstIndex(where: { $0.action == action }) {
      bindings[index].chord = chord
    } else {
      bindings.append(RemoteBinding(action: action, chord: chord))
    }
  }
}

public struct RemoteControlStore: Sendable {
  private let root: URL

  public init(root: URL = DirectorPaths.remoteControl) {
    self.root = root
  }

  private var manifestURL: URL {
    root.appendingPathComponent("remote-control.json")
  }

  public func loadManifest() -> RemoteControlManifest {
    guard let data = try? Data(contentsOf: manifestURL) else {
      return RemoteControlManifest.emptyDefault()
    }
    if let manifest = try? JSONDecoder().decode(RemoteControlManifest.self, from: data),
       !manifest.templates.isEmpty {
      return repaired(manifest)
    }
    return RemoteControlManifest.emptyDefault()
  }

  public func save(_ manifest: RemoteControlManifest) {
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(repaired(manifest)) else { return }
    try? data.write(to: manifestURL, options: .atomic)
  }

  private func repaired(_ manifest: RemoteControlManifest) -> RemoteControlManifest {
    var manifest = manifest
    if manifest.templates.isEmpty {
      return RemoteControlManifest.emptyDefault()
    }
    if !manifest.templates.contains(where: { $0.id == manifest.activeTemplateID }) {
      manifest.activeTemplateID = manifest.templates[0].id
    }
    for index in manifest.templates.indices {
      manifest.templates[index].bindings = RemoteChordRules.normalize(
        manifest.templates[index].bindings
      )
    }
    return manifest
  }
}
