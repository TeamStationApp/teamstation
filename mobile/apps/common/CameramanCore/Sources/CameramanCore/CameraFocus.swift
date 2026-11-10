import Foundation

/// Top-left coordinates in the encoded image, before any receiver-only crop.
public struct FocusPoint: Sendable, Equatable, Codable {
  public let x: Double
  public let y: Double

  public init?(x: Double, y: Double) {
    guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { return nil }
    self.x = x
    self.y = y
  }
}

public enum FocusPhase: String, Sendable, Codable {
  case auto, focusing, locked, failed, unsupported, reset

  public var label: String {
    switch self {
    case .auto: "Auto Focus"
    case .focusing: "Focusing"
    case .locked: "Focus locked"
    case .failed: "Focus failed"
    case .unsupported: "Focus unavailable"
    case .reset: "Focus reset"
    }
  }
}

public struct CameraFocus: Sendable, Equatable {
  public var supported = false
  public var phase: FocusPhase = .unsupported
  public var point: FocusPoint?
  public var request = ""
  public var generation = ""
  public var rotation = 0
  public var mirrored = false

  public init() {}

  public mutating func reset(supported: Bool, generation: String = UUID().uuidString) {
    self.supported = supported
    self.generation = generation
    phase = supported ? .reset : .unsupported
    point = nil
    request = ""
  }

  /// False for a stale preview or retransmitted command. No caller may treat acceptance as a lock.
  @discardableResult
  public mutating func begin(_ command: FocusCommand) -> Bool {
    guard command.generation == generation, command.token != request else { return false }
    request = command.token
    point = command.point
    phase = supported ? (point == nil ? .auto : .focusing) : .unsupported
    return supported
  }

  @discardableResult
  public mutating func complete(_ command: FocusCommand, success: Bool) -> Bool {
    guard generation == command.generation, request == command.token, phase == .focusing else { return false }
    phase = success ? .locked : .failed
    return true
  }
}

public struct FocusCommand: Sendable, Equatable {
  public let generation: String
  public let token: String
  public let point: FocusPoint?

  public init?(generation: String, token: String, point: FocusPoint?) {
    guard Self.validID(generation), Self.validID(token) else { return nil }
    self.generation = generation
    self.token = token
    self.point = point
  }

  public init?(text: String) {
    let parts = text.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3 || parts.count == 5 else { return nil }
    let point: FocusPoint?
    if parts[0] == "auto", parts.count == 3 {
      point = nil
    } else if parts[0] == "point", parts.count == 5,
              let x = Double(parts[3]), let y = Double(parts[4]), let parsed = FocusPoint(x: x, y: y) {
      point = parsed
    } else { return nil }
    self.init(generation: parts[1], token: parts[2], point: point)
  }

  public var text: String {
    if let point { return "point:\(generation):\(token):\(point.x):\(point.y)" }
    return "auto:\(generation):\(token)"
  }

  private static func validID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 64 && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
    }
  }
}

public enum FocusGeometry {
  /// Aspect-fit/fill picture coordinates. Bars are never focus targets. Preview mirroring and
  /// receiver-only zoom are removed here; the camera removes its own transform separately.
  public static func imagePoint(
    x: Double, y: Double, width: Double, height: Double,
    imageWidth: Double, imageHeight: Double, fill: Bool = false,
    mirrored: Bool = false, receiverZoom: Double = 1
  ) -> FocusPoint? {
    guard [x, y, width, height, imageWidth, imageHeight, receiverZoom].allSatisfy({ $0.isFinite }),
          width > 0, height > 0, imageWidth > 0, imageHeight > 0, receiverZoom >= 1,
          x >= 0, y >= 0, x <= width, y <= height else { return nil }
    let scale = fill ? max(width / imageWidth, height / imageHeight) : min(width / imageWidth, height / imageHeight)
    let drawnWidth = imageWidth * scale
    let drawnHeight = imageHeight * scale
    let px = (x - (width - drawnWidth) / 2) / drawnWidth
    let py = (y - (height - drawnHeight) / 2) / drawnHeight
    guard let visible = FocusPoint(x: px, y: py) else { return nil }
    return FocusPoint(x: 0.5 + ((mirrored ? 1 - visible.x : visible.x) - 0.5) / receiverZoom,
                      y: 0.5 + (visible.y - 0.5) / receiverZoom)
  }

  /// Inverse of a clockwise image rotation, after removing horizontal image mirroring.
  public static func unrotated(_ point: FocusPoint, rotation: Int, mirrored: Bool) -> FocusPoint? {
    let x = mirrored ? 1 - point.x : point.x
    switch ((rotation % 360) + 360) % 360 {
    case 0: return FocusPoint(x: x, y: point.y)
    case 90: return FocusPoint(x: point.y, y: 1 - x)
    case 180: return FocusPoint(x: 1 - x, y: 1 - point.y)
    case 270: return FocusPoint(x: 1 - point.y, y: x)
    default: return nil
    }
  }
}
