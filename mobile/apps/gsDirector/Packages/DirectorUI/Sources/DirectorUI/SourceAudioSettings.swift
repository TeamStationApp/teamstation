import Foundation
import DirectorCore
import DirectorSources

/// The operator's two audio decisions for one camera: whether its microphone is in the programme
/// mix, and how loud it goes in.
///
/// They live here as well as on the row because a row is a sighting and a camera is not. A row is
/// keyed by `SourceID`, which is only as durable as what the camera says about itself: an NDI
/// source renames itself and becomes a new row, a phone that is answering before it has presented
/// a `CNAME` is session-keyed and is never written to disk at all. Either way the operator gets a
/// row with `usesAudio` defaulted on, and a camera they had taken out of the mix is back in it.
public struct SourceAudioSetting: Hashable, Sendable, Codable {
  public var usesAudio: Bool
  public var inputGain: Double

  public init(usesAudio: Bool, inputGain: Double) {
    self.usesAudio = usesAudio
    self.inputGain = SourceSelectionRules.clampedInputGain(inputGain)
  }

  public init(_ selection: SourceSelection) {
    self.init(usesAudio: selection.usesAudio, inputGain: selection.inputGain)
  }
}

/// How a camera's audio decisions are filed, and how they are put back on a row. Pure functions, so
/// the rules are testable without a device.
public enum SourceAudioRules {
  /// The key one camera's decisions are remembered under.
  ///
  /// The camera's own identifier and nothing else: NearStream's `modelname`/`wlanmac`, the uuid a
  /// GS Cameraman puts in its `CNAME`, or that `CNAME` verbatim. Never `customName` and never
  /// `advertisedName` — the operator renames a camera mid-game and a camera announces itself
  /// differently after a firmware update, and neither is a different camera.
  ///
  /// A source with no camera record falls back to its own `SourceID`, but only where that id is
  /// durable: an NDI name, a fixture, a synthetic. A `session-…` key is this launch's bookkeeping
  /// for a socket nobody has identified, so there is nothing to remember it by and this answers nil.
  public static func key(for selection: SourceSelection, record: CameraRecord?) -> String? {
    if let hardwareID = nonEmpty(record?.hardwareID) { return "hw:\(hardwareID)" }
    if let cname = nonEmpty(record?.lastKnownCNAME) { return "cname:\(cname)" }
    guard SourceSelectionRules.isPersistable(selection) else { return nil }
    return "id:\(selection.id.rawValue)"
  }

  /// Puts remembered decisions back on the rows.
  ///
  /// A row whose camera has never been touched keeps what it came with, so a genuinely new camera
  /// still behaves as it always did. A row that is somebody's control link keeps its audio off:
  /// it has no tile and no place in the mix, and a remembered `true` from before it was linked
  /// must not put it back in one.
  public static func applying(
    _ settings: [String: SourceAudioSetting],
    to selections: [SourceSelection],
    key: (SourceSelection) -> String?
  ) -> [SourceSelection] {
    guard !settings.isEmpty else { return selections }
    let controls = SourceSelectionRules.linkedControlIDs(in: selections)
    return selections.map { selection in
      guard !controls.contains(selection.id),
            let key = key(selection),
            let setting = settings[key]
      else { return selection }
      var updated = selection
      updated.usesAudio = setting.usesAudio
      updated.inputGain = SourceSelectionRules.clampedInputGain(setting.inputGain)
      return updated
    }
  }

  /// Files what one row currently says, under that row's camera. What the operator just changed.
  public static func remembering(
    _ selection: SourceSelection,
    in settings: inout [String: SourceAudioSetting],
    key: (SourceSelection) -> String?
  ) {
    guard let key = key(selection) else { return }
    settings[key] = SourceAudioSetting(selection)
  }

  /// Takes the rows as the truth for any camera not yet on file.
  ///
  /// The migration: an iPad that has been switching games for months has every operator decision
  /// in its source list and nothing in this store, and the first launch after the update must not
  /// read that as "no decisions made". Cameras already on file are left alone, because the store is
  /// the durable record and the row may be a sighting that arrived with the defaults.
  public static func seeding(
    from selections: [SourceSelection],
    into settings: inout [String: SourceAudioSetting],
    key: (SourceSelection) -> String?
  ) {
    let controls = SourceSelectionRules.linkedControlIDs(in: selections)
    for selection in selections where !controls.contains(selection.id) {
      guard let key = key(selection), settings[key] == nil else { continue }
      settings[key] = SourceAudioSetting(selection)
    }
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    return trimmed
  }
}

/// Where the audio decisions live: a file of their own, keyed by camera rather than by row.
///
/// A file rather than `UserDefaults`, because `UserDefaults` is not a write to disk. It is a
/// message to `cfprefsd`, which writes the plist when it gets round to it, and the operator's
/// habit here is to force-quit the app from the app switcher — which is precisely the ending
/// `UserDefaults` does not promise to survive. `Data.write(options: .atomic)` is on disk when it
/// returns, and the payload is a few hundred bytes, so paying for that on every change is nothing.
public struct SourceAudioStore: Sendable {
  private let url: URL

  public init(url: URL = DirectorPaths.applicationSupport.appendingPathComponent("audio.json")) {
    self.url = url
  }

  public func load() -> [String: SourceAudioSetting] {
    guard let data = try? Data(contentsOf: url) else { return [:] }
    return (try? JSONDecoder().decode([String: SourceAudioSetting].self, from: data)) ?? [:]
  }

  public func save(_ settings: [String: SourceAudioSetting]) {
    guard let data = try? JSONEncoder().encode(settings) else { return }
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try? data.write(to: url, options: .atomic)
  }

  public func clear() {
    try? FileManager.default.removeItem(at: url)
  }
}
