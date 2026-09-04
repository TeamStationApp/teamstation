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
  case setCodec(String)
  case setName(String)
  case setAudio(on: Bool)
  case setLenses(disabled: [String])
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
