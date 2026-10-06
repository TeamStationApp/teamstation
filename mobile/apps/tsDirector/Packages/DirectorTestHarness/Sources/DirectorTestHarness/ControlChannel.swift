import Foundation
import DirectorCore

/// Commands the `tsdirector://` URL scheme can deliver.
///
/// The channel exists so state assertions do not depend on gesture precision. It does not replace
/// gesture coverage — the drag keeps its own `swipe` flow.
public enum ControlCommand: Sendable, Equatable {
  case configure([String: String])
  case scrub(source: Int, offsetSeconds: Double)
  case returnToLive(source: Int)
  case record(on: Bool)
  case stream(on: Bool)
  case startDirecting
  case selectProgram(source: Int)
  /// Which camera carries the sound, by grid slot, mid-take included, exactly as the toggle does.
  case selectAudioSource(source: Int)
  /// Instant replay on a 0-based source. `speed` is `full` or `slow`.
  case replay(source: Int, seconds: Double, speed: String)
  /// Slow-motion playback rate as a percentage. Exists so a flow can exercise a rate that is not
  /// one over a whole number — the setting a person changes lives in Settings, which a test cannot
  /// reach, and 50% happens to be the one value that hides a rounding bug.
  case setSlowMotionRate(percent: Double)
  case enableSource(index: Int, on: Bool)
  case sourceAudio(index: Int, on: Bool)
  case sourceGain(index: Int, gain: Double)
  case renameSource(index: Int, name: String)
  case assignSource(index: Int, slot: Int)
  case remoteChord(controls: [String])
  case bindRemote(action: String, controls: [String])
  /// Names the camera on a row, or points that row at a camera already in the cache. The two
  /// operations a flow needs to exercise identity without driving a menu by coordinates.
  case nameCamera(index: Int, name: String)
  case bindCamera(index: Int, name: String)
  case forgetCamera(index: Int)
  /// Points row `video`'s tile at row `control`'s parameter channel, and clears a link from either
  /// of its rows. Row indices, 0-based here and 1-based on the wire, like `enableSource`.
  case linkSource(video: Int, control: Int)
  case unlinkSource(index: Int)
  /// Searches the network now, without waiting for the next periodic sweep.
  case searchCameras
  /// Sweep this /24 for cameras instead of the local subnet, or stop. Saved, like the Settings switch.
  case setSubnetScan(subnet: String?, on: Bool?)
  /// The display latency cap, and so the live delay D, in milliseconds; 0 turns it off. Saved, like
  /// the Performance sheet's switch and slider, so it holds across launches.
  case setDisplayLatencyCap(milliseconds: Double)
  /// Opens or closes the Cameraman control screen on a 0-based source.
  case cameraControl(source: Int, open: Bool)
  /// Director's own zoom on a 0-based source's picture, 1 for none.
  case digitalZoom(source: Int, zoom: Double)
  case advanceClock(seconds: TimeInterval)
  case probeEncoders(maximum: Int, framesPerSession: Int, width: Int, height: Int, fps: Int)
  case probeThroughput(sessions: Int, seconds: Double, height: Int, hevc: Bool, fps: Int)
  case probeWriter(options: [String: String])
  case dumpState
  case reset
  /// Visual-slot order of the five sources, 0-based. Source numbers stay put; only tiles move.
  /// `corner` names Output's corner (`topLeading`, `topTrailing`, `bottomLeading`,
  /// `bottomTrailing`); absent or unknown keeps the current one.
  case sourceLayout(order: [Int], corner: String? = nil)
  /// UITest-only: fail the live program `AVAssetWriter` mid-take.
  case killProgramWriter
  /// UITest-only: remux the latest stopped take into Prepared/ without opening the share sheet.
  /// `reprocess` rebuilds files already there, so a changed export can be judged on an old take.
  case exportRecording(reprocess: Bool)
  /// UITest-only: kill this process outright, with no lifecycle callbacks and no chance to
  /// finalise anything. The only way to write a test for what the app does after a crash, since
  /// terminating it politely exercises the stop path instead — which is the path that works.
  case crash
}

public enum ControlChannel {
  public static let scheme = "tsdirector"

  /// Parses `tsdirector://test/<command>?<query>`. Returns `nil` for anything unrecognised so
  /// a typo in a flow fails loudly rather than silently doing nothing else.
  public static func command(from url: URL) -> ControlCommand? {
    guard url.scheme?.lowercased() == scheme else { return nil }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

    // tsdirector://test/scrub -> host "test", path "/scrub"
    let action = components.path
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      .lowercased()
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] {
      query[item.name] = item.value ?? ""
    }

    switch action {
    case "configure":
      return .configure(query)
    case "scrub":
      guard let source = Self.slot(query) else { return nil }
      let offset = query["offset"].flatMap { Double($0) } ?? 0
      return .scrub(source: source - 1, offsetSeconds: offset)
    case "return-to-live", "returntolive":
      guard let source = Self.slot(query) else { return nil }
      return .returnToLive(source: source - 1)
    case "record":
      return .record(on: LaunchConfiguration.boolean(query["on"]) ?? true)
    case "stream":
      return .stream(on: LaunchConfiguration.boolean(query["on"]) ?? true)
    case "start", "start-directing", "startdirecting":
      return .startDirecting
    case "program":
      guard let source = Self.slot(query) else { return nil }
      return .selectProgram(source: source - 1)
    case "audio", "audio-source", "audiosource":
      guard let source = Self.slot(query) else { return nil }
      return .selectAudioSource(source: source - 1)
    case "replay":
      guard let source = Self.slot(query) else { return nil }
      guard let seconds = query["seconds"].flatMap({ Double($0) }), seconds > 0 else { return nil }
      let speed = (query["speed"] ?? "full").lowercased()
      guard speed == "full" || speed == "slow" else { return nil }
      return .replay(source: source - 1, seconds: seconds, speed: speed)
    case "set-slowmo", "setslowmo":
      guard let percent = query["percent"].flatMap(Double.init), percent > 0 else { return nil }
      return .setSlowMotionRate(percent: percent)

    case "assign-source", "assignsource":
      guard let index = query["index"].flatMap({ Int($0) }) else { return nil }
      let slot = query["slot"].flatMap { Int($0) } ?? Self.slot(query)
      guard let slot else { return nil }
      return .assignSource(index: index - 1, slot: slot - 1)
    case "remote-chord", "remotechord":
      return .remoteChord(controls: Self.csv(query["controls"]))
    case "bind-remote", "bindremote":
      guard let actionID = query["action"] else { return nil }
      return .bindRemote(action: actionID, controls: Self.csv(query["controls"]))
    case "probe-encoders", "probeencoders":
      return .probeEncoders(
        maximum: query["max"].flatMap { Int($0) } ?? 8,
        framesPerSession: query["frames"].flatMap { Int($0) } ?? 1,
        width: query["width"].flatMap { Int($0) } ?? 1920,
        height: query["height"].flatMap { Int($0) } ?? 1080,
        fps: query["fps"].flatMap { Int($0) } ?? 30
      )
    case "probe-throughput", "probethroughput":
      return .probeThroughput(
        sessions: query["sessions"].flatMap { Int($0) } ?? 4,
        seconds: query["seconds"].flatMap { Double($0) } ?? 20,
        height: query["height"].flatMap { Int($0) } ?? 1080,
        hevc: LaunchConfiguration.boolean(query["hevc"]) ?? false,
        fps: query["fps"].flatMap { Int($0) } ?? 30
      )
    case "probe-writer", "probewriter":
      return .probeWriter(options: query)
    case "enable-source", "enablesource":
      guard let index = query["index"].flatMap({ Int($0) }) else { return nil }
      return .enableSource(index: index - 1, on: LaunchConfiguration.boolean(query["on"]) ?? true)
    case "source-audio", "sourceaudio":
      guard let index = query["index"].flatMap({ Int($0) }) else { return nil }
      return .sourceAudio(index: index - 1, on: LaunchConfiguration.boolean(query["on"]) ?? true)
    case "source-gain", "sourcegain":
      guard let index = query["index"].flatMap({ Int($0) }) else { return nil }
      let gain = query["gain"].flatMap { Double($0) } ?? 0.5
      return .sourceGain(index: index - 1, gain: gain)
    case "rename-source", "renamesource":
      guard let index = query["index"].flatMap({ Int($0) }), let name = query["name"] else { return nil }
      return .renameSource(index: index - 1, name: name)
    case "name-camera", "namecamera":
      guard let index = query["index"].flatMap({ Int($0) }), let name = query["name"] else { return nil }
      return .nameCamera(index: index - 1, name: name)
    case "bind-camera", "bindcamera":
      guard let index = query["index"].flatMap({ Int($0) }), let name = query["name"] else { return nil }
      return .bindCamera(index: index - 1, name: name)
    case "forget-camera", "forgetcamera":
      guard let index = query["index"].flatMap({ Int($0) }) else { return nil }
      return .forgetCamera(index: index - 1)
    case "link-source", "linksource":
      guard let video = query["video"].flatMap({ Int($0) }),
            let control = query["control"].flatMap({ Int($0) })
      else { return nil }
      return .linkSource(video: video - 1, control: control - 1)
    case "unlink-source", "unlinksource":
      guard let index = query["index"].flatMap({ Int($0) }) else { return nil }
      return .unlinkSource(index: index - 1)
    case "search-cameras", "searchcameras":
      return .searchCameras
    case "subnet-scan", "subnetscan":
      let on = query["on"].flatMap { LaunchConfiguration.boolean($0) }
      guard query["subnet"] != nil || on != nil else { return nil }
      return .setSubnetScan(subnet: query["subnet"], on: on)
    case "display-latency-cap", "displaylatencycap":
      guard let milliseconds = query["ms"].flatMap({ Double($0) }), milliseconds.isFinite, milliseconds >= 0
      else { return nil }
      return .setDisplayLatencyCap(milliseconds: milliseconds)
    case "camera-control", "cameracontrol":
      guard let source = Self.slot(query) else { return nil }
      return .cameraControl(source: source - 1, open: LaunchConfiguration.boolean(query["open"]) ?? true)
    case "digital-zoom", "digitalzoom":
      guard let source = Self.slot(query),
            let zoom = query["zoom"].flatMap({ Double($0) }), zoom.isFinite
      else { return nil }
      return .digitalZoom(source: source - 1, zoom: zoom)
    case "advance-clock", "advanceclock":
      guard let seconds = query["seconds"].flatMap({ Double($0) }) else { return nil }
      return .advanceClock(seconds: seconds)
    case "dump-state", "dumpstate":
      return .dumpState
    case "reset":
      return .reset
    case "source-layout", "sourcelayout":
      guard let order = Self.layoutOrder(query) else { return nil }
      return .sourceLayout(order: order, corner: query["corner"])
    case "kill-program-writer", "killprogramwriter":
      return .killProgramWriter
    case "export-recording", "exportrecording":
      return .exportRecording(reprocess: query["reprocess"].flatMap { LaunchConfiguration.boolean($0) } ?? false)
    case "crash":
      return .crash
    default:
      return nil
    }
  }

  /// 1-based slot from `source=` or the pre-rename `tile=` query.
  private static func slot(_ query: [String: String]) -> Int? {
    (query["source"] ?? query["tile"]).flatMap { Int($0) }
  }

  private static func csv(_ value: String?) -> [String] {
    (value ?? "")
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
      .filter { !$0.isEmpty }
  }

  /// 1-based source numbers in visual-slot order, converted to 0-based indices.
  private static func layoutOrder(_ query: [String: String]) -> [Int]? {
    let parts = (query["order"] ?? "")
      .split(separator: ",")
      .compactMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    guard parts.count == SourceIndex.count else { return nil }
    let order = parts.map { $0 - 1 }
    guard order.allSatisfy({ (0 ..< SourceIndex.count).contains($0) }) else { return nil }
    return order
  }
}

/// Writes a JSON snapshot into the app container for `scripts/verifyArchive.js` to read.
/// Generic over `Encodable` so the harness does not have to depend on `DirectorPipeline`.
public struct StateDumper: Sendable {
  public let url: URL

  public init(url: URL = DirectorPaths.telemetryDump) {
    self.url = url
  }

  @discardableResult
  public func dump(_ value: some Encodable) -> Bool {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .prettyPrinted, .sortedKeys ]
    guard let data = try? encoder.encode(value) else { return false }
    do {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: url, options: .atomic)
      return true
    } catch {
      return false
    }
  }
}
