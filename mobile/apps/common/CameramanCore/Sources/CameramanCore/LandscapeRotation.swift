import Foundation

/// The capture angle for a camera whose picture follows the interface's landscape orientation.
///
/// The interface reports the angle the back camera needs for it: 0° for landscape right, 180° for
/// landscape left. A connection's `videoRotationAngle` turns the buffers from the sensor's own
/// orientation, and the front sensor sits half a turn from the back one, so the front camera needs
/// the opposite angle for the same interface. Given the back camera's angle, the front picture, both
/// on screen and in the encoded buffers, comes out upside down.
///
/// Portrait and unknown readings, such as those a sheet that may stand upright reports while it is
/// up, keep the last landscape: a portrait angle would turn 1920×1080 into portrait.
public struct LandscapeRotation: Sendable, Equatable {
  /// The last landscape the interface reported, 0° or 180°; nil until it has reported one.
  public private(set) var interfaceAngle: Double?
  public var position: CameraPosition

  public init(position: CameraPosition = .back, interfaceAngle: Double? = nil) {
    self.position = position
    self.interfaceAngle = interfaceAngle.flatMap(Self.landscape)
  }

  /// Takes an interface reading. Returns whether it was a landscape one.
  @discardableResult
  public mutating func report(interfaceAngle angle: Double) -> Bool {
    guard let landscape = Self.landscape(angle) else { return false }
    interfaceAngle = landscape
    return true
  }

  /// The angle for both the capture connection and the preview layer's connection of the camera at
  /// `position`; nil until the interface has reported a landscape.
  public var captureAngle: Double? {
    interfaceAngle.map { Self.captureAngle(interface: $0, position: position) }
  }

  public static func captureAngle(interface: Double, position: CameraPosition) -> Double {
    switch position {
    case .back: return interface
    case .front: return interface == 0 ? 180 : 0
    }
  }

  /// 0° or 180°, nil for any other reading.
  public static func landscape(_ angle: Double) -> Double? {
    angle == 0 || angle == 180 ? angle : nil
  }
}
