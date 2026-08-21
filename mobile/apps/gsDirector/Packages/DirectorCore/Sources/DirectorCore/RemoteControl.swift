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
    let n = sourceIndex + 1
    switch self {
    case .cutLive:
      return "Source \(n) live"
    case let .instantReplay(_, seconds, speed):
      let amount = seconds == seconds.rounded() ? String(Int(seconds)) : String(format: "%g", seconds)
      if speed == .full { return "Source \(n) · \(amount)s" }
      return "Source \(n) · \(amount)s ×\(Int((slowMotionPercent * 100).rounded()))%"
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

  public static let all: [RemoteAction] = {
    (0 ..< SourceIndex.count).flatMap { source in
      [ RemoteAction.cutLive(source) ] + replayOffsets.flatMap { seconds in
        [
          RemoteAction.instantReplay(source: source, seconds: seconds, speed: .full),
          RemoteAction.instantReplay(source: source, seconds: seconds, speed: .slow)
        ]
      }
    }
  }()
}

public struct RemoteChord: Sendable, Codable, Hashable {
  public var controls: [ControlID]

  public init(controls: [ControlID] = []) {
    var seen: Set<ControlID> = []
    self.controls = controls.filter { seen.insert($0).inserted }
  }

  public var set: Set<ControlID> { Set(controls) }
  public var isEmpty: Bool { controls.isEmpty }

  public mutating func append(_ id: ControlID) {
    if !controls.contains(id) { controls.append(id) }
  }

  public mutating func clear() {
    controls = []
  }
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
  /// Largest chord that is a subset of `pressed`. Empty chords never match.
  public static func match(
    pressed: Set<ControlID>,
    bindings: [RemoteBinding]
  ) -> RemoteAction? {
    bindings
      .filter { !$0.chord.isEmpty && $0.chord.set.isSubset(of: pressed) }
      .max { lhs, rhs in lhs.chord.controls.count < rhs.chord.controls.count }?
      .action
  }

  /// Record `id` on `action`. Another action that ends up with the same set is cleared.
  public static func append(
    _ id: ControlID,
    to action: RemoteAction,
    in bindings: inout [RemoteBinding]
  ) {
    if let index = bindings.firstIndex(where: { $0.action == action }) {
      bindings[index].chord.append(id)
    } else {
      var chord = RemoteChord()
      chord.append(id)
      bindings.append(RemoteBinding(action: action, chord: chord))
    }
    let set = Set(bindings.first { $0.action == action }?.chord.controls ?? [])
    for index in bindings.indices where bindings[index].action != action {
      if Set(bindings[index].chord.controls) == set {
        bindings[index].chord.clear()
      }
    }
    bindings.removeAll { $0.chord.isEmpty && $0.action != action }
  }

  public static func clear(action: RemoteAction, in bindings: inout [RemoteBinding]) {
    bindings.removeAll { $0.action == action }
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
      if remaining.isEmpty {
        if !binding.chord.isEmpty { dropped += 0 }
        continue
      }
      kept.append(RemoteBinding(action: binding.action, chord: RemoteChord(controls: remaining)))
    }
    return (kept, dropped)
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
    return manifest
  }
}
