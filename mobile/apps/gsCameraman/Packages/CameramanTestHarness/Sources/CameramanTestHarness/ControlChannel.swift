import Foundation

/// Commands a test can send the running app.
///
/// The camera controls are gestures — a pinch that has to land on the right zoom, a menu that has
/// to be tapped — and asserting on them through the gesture alone conflates "the app got the zoom
/// wrong" with "the tap landed 8 points off". This channel drives the same state directly, so a
/// gesture flow and a state flow can fail independently and say different things.
public enum ControlCommand: Sendable, Equatable {
  case dumpState
  case flipCamera
  case setZoom(displayed: Double)
  case setFormat(width: Int, height: Int, fps: Int)
  case setBitrate(mbps: Double)
  /// Adaptive bitrate on or off. Either way the encoder goes back to the operator's rate.
  case setAdaptiveBitrate(on: Bool)
  case setCodec(String)
  case setName(String)
  case setAudio(on: Bool)
  case setLenses(disabled: [String])
  case setVideo(on: Bool)
  /// The clean external-display feed. Off hands a connected display back to iOS mirroring.
  case setCleanHDMI(on: Bool)
  /// Hold outgoing frames back to imitate a congested link. All three in milliseconds; all zero
  /// restores immediate delivery.
  case setSendDelay(milliseconds: Double, jitter: Double, burst: Double)
  case forceKeyframe
  case clients
  case reset
}

public enum ControlChannel {
  public static let scheme = "gscameraman"

  /// Parses `gscameraman://test/<command>?<query>`.
  ///
  /// Anything unrecognised returns nil rather than being ignored, so a typo in a flow fails where
  /// it was typed instead of three assertions later.
  public static func command(from url: URL) -> ControlCommand? {
    guard url.scheme?.lowercased() == scheme else { return nil }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }

    let action = components.path
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      .lowercased()
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] {
      query[item.name] = item.value ?? ""
    }

    switch action {
    case "dump-state": return .dumpState
    case "flip-camera": return .flipCamera
    case "force-keyframe": return .forceKeyframe
    case "clients": return .clients
    case "reset": return .reset

    case "set-zoom":
      guard let displayed = query["displayed"].flatMap(Double.init) else { return nil }
      return .setZoom(displayed: displayed)

    case "set-format":
      guard
        let width = query["width"].flatMap(Int.init),
        let height = query["height"].flatMap(Int.init)
      else { return nil }
      // A format request without a rate means "whatever this size normally runs at", and 30 is what
      // every size on this hardware normally runs at.
      return .setFormat(width: width, height: height, fps: query["fps"].flatMap(Int.init) ?? 30)

    case "set-bitrate":
      guard let mbps = query["mbps"].flatMap(Double.init) else { return nil }
      return .setBitrate(mbps: mbps)

    case "set-adaptive-bitrate":
      guard let on = query["on"].map(isTruthy) else { return nil }
      return .setAdaptiveBitrate(on: on)

    case "set-codec":
      guard let codec = query["codec"], !codec.isEmpty else { return nil }
      return .setCodec(codec.lowercased())

    case "set-name":
      // An empty name is a real request — it is how a flow checks the fallback name appears.
      return .setName(query["name"] ?? "")

    case "set-audio":
      guard let on = query["on"].map(isTruthy) else { return nil }
      return .setAudio(on: on)

    case "set-lenses":
      let disabled = (query["disabled"] ?? "")
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
      return .setLenses(disabled: disabled)

    case "set-video":
      guard let on = query["on"].map(isTruthy) else { return nil }
      return .setVideo(on: on)

    case "set-clean-hdmi":
      guard let on = query["on"].map(isTruthy) else { return nil }
      return .setCleanHDMI(on: on)

    case "set-send-delay", "setsenddelay":
      // Every field optional so a flow can set only what it is exercising; omitted means zero.
      let ms = query["ms"].flatMap(Double.init) ?? 0
      let jitter = query["jitter"].flatMap(Double.init) ?? 0
      let burst = query["burst"].flatMap(Double.init) ?? 0
      return .setSendDelay(milliseconds: ms, jitter: jitter, burst: burst)

    default:
      return nil
    }
  }

  /// `1`, `true` and `yes` all appear in hand-written flows, and a flow that silently reads `yes`
  /// as false is a bad way to spend an afternoon.
  private static func isTruthy(_ value: String) -> Bool {
    [ "1", "true", "yes", "on" ].contains(value.lowercased())
  }
}
