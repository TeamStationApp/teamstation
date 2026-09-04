import Foundation

/// Raw `AVCaptureDevice.DeviceType` values, stored as strings so selection rules can be tested
/// without AVFoundation.
public enum CameraDeviceTypeName {
  public static let wideAngle = "AVCaptureDeviceTypeBuiltInWideAngleCamera"
  public static let ultraWide = "AVCaptureDeviceTypeBuiltInUltraWideCamera"
  public static let telephoto = "AVCaptureDeviceTypeBuiltInTelephotoCamera"
  public static let triple = "AVCaptureDeviceTypeBuiltInTripleCamera"
  public static let dualWide = "AVCaptureDeviceTypeBuiltInDualWideCamera"
  public static let dual = "AVCaptureDeviceTypeBuiltInDualCamera"
}

/// One optical camera the handset actually has, including a native crop such as the 48 mm 2x
/// on a 48 MP wide sensor.
///
/// IDs and millimetre values are measured from the device, never hardcoded per iPhone model. A 13 Pro
/// reports three back lenses; a 15 Pro reports four because its wide sensor has a secondary native
/// resolution at 2x. The settings list is this array, one toggle per entry.
public struct CameraLens: Sendable, Equatable, Identifiable, Hashable, Codable {
  public var id: String
  public var position: CameraPosition
  public var deviceType: String
  public var uniqueDeviceID: String
  public var focalLengthMM: Int?
  public var displayedZoom: Double
  public var deviceZoom: Double
  public var isSecondaryNative: Bool

  public init(
    id: String,
    position: CameraPosition,
    deviceType: String,
    uniqueDeviceID: String,
    focalLengthMM: Int?,
    displayedZoom: Double,
    deviceZoom: Double,
    isSecondaryNative: Bool
  ) {
    self.id = id
    self.position = position
    self.deviceType = deviceType
    self.uniqueDeviceID = uniqueDeviceID
    self.focalLengthMM = focalLengthMM
    self.displayedZoom = displayedZoom
    self.deviceZoom = deviceZoom
    self.isSecondaryNative = isSecondaryNative
  }

  /// `13 mm` when FOV was readable, otherwise the zoom label the operator already knows.
  public var title: String {
    if let focalLengthMM { return "\(focalLengthMM) mm" }
    return ZoomMapping.label(forDisplayed: displayedZoom)
  }

  public var subtitle: String {
    let side = position == .back ? "Back" : "Front"
    return "\(side) · \(ZoomMapping.label(forDisplayed: displayedZoom))"
  }

  /// Compact settings row: millimetres plus which camera, so five rows fit a landscape column.
  public var settingsLabel: String {
    "\(title) · \(position == .back ? "Back" : "Front")"
  }

  public var accessibilityIdentifier: String {
    "settings-lens-\(position.rawValue)-\(ZoomMapping.label(forDisplayed: displayedZoom))"
  }
}

/// 35 mm-equivalent focal length from a measured horizontal field of view.
///
/// Blackmagic's 13 / 24 / 48 / 77 mm labels are this conversion, not a per-model table. Full-frame
/// width is 36 mm, so `f = 18 / tan(fov/2)`.
public enum LensOptics {
  public static func equivalentFocalLengthMM(horizontalFieldOfViewDegrees: Double) -> Int? {
    guard horizontalFieldOfViewDegrees.isFinite,
          horizontalFieldOfViewDegrees > 1,
          horizontalFieldOfViewDegrees < 179
    else { return nil }
    let radians = horizontalFieldOfViewDegrees * .pi / 180
    let millimetres = 18 / tan(radians / 2)
    guard millimetres.isFinite, millimetres > 0, millimetres < 500 else { return nil }
    return Int(millimetres.rounded())
  }

  /// Horizontal FOV after cropping by `factor` (2.0 for a native 2x). Used for the 48 mm row.
  public static func croppedFieldOfViewDegrees(
    horizontalFieldOfViewDegrees: Double,
    factor: Double
  ) -> Double? {
    guard horizontalFieldOfViewDegrees.isFinite, horizontalFieldOfViewDegrees > 1, factor > 1 else {
      return nil
    }
    let half = tan(horizontalFieldOfViewDegrees * .pi / 360) / factor
    guard half > 0 else { return nil }
    return 2 * atan(half) * 180 / .pi
  }
}
