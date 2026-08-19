import Foundation

/// Conversions between the two zoom scales a virtual multi-lens camera exposes.
///
/// These are separated from any capture code on purpose, because conflating them is *the* classic
/// bug in this feature. `AVCaptureDevice.videoZoomFactor` is `1.0` at the **widest constituent**,
/// which on a triple camera is the ultra-wide. The number an operator expects to read is
/// `videoZoomFactor * displayVideoZoomFactorMultiplier`, so on an iPhone 13 Pro device zoom `1.0`
/// shows as `0.5x` and device `2.0` shows as `1x`, matching Apple's own Camera app.
public struct ZoomMapping: Sendable, Equatable {
  public let minimumDeviceZoom: Double
  public let maximumDeviceZoom: Double
  /// `AVCaptureDevice.displayVideoZoomFactorMultiplier`: 0.5 on a device whose widest lens is an
  /// ultra-wide, 1.0 on a single-lens front camera.
  public let displayMultiplier: Double
  /// Device-zoom values at which the virtual device hands over to the next constituent lens,
  /// i.e. `virtualDeviceSwitchOverVideoZoomFactors`.
  public let switchOverDeviceZooms: [Double]

  public init(
    minimumDeviceZoom: Double = 1,
    maximumDeviceZoom: Double,
    displayMultiplier: Double = 1,
    switchOverDeviceZooms: [Double] = []
  ) {
    let minimum = minimumDeviceZoom > 0 ? minimumDeviceZoom : 1
    let maximum = max(maximumDeviceZoom, minimum)
    self.minimumDeviceZoom = minimum
    self.maximumDeviceZoom = maximum
    self.displayMultiplier = displayMultiplier > 0 ? displayMultiplier : 1
    // A switchover at or below the minimum is unreachable, and one above the maximum can never be
    // crossed; either would produce a preset pill that does nothing when tapped.
    self.switchOverDeviceZooms = switchOverDeviceZooms
      .filter { $0 > minimum && $0 <= maximum }
      .sorted()
  }

  public func displayedZoom(forDevice deviceZoom: Double) -> Double {
    deviceZoom * displayMultiplier
  }

  public func deviceZoom(forDisplayed displayedZoom: Double) -> Double {
    displayedZoom / displayMultiplier
  }

  public func clampDeviceZoom(_ value: Double) -> Double {
    guard value.isFinite else { return minimumDeviceZoom }
    return min(max(value, minimumDeviceZoom), maximumDeviceZoom)
  }

  public func clampDisplayedZoom(_ value: Double) -> Double {
    displayedZoom(forDevice: clampDeviceZoom(deviceZoom(forDisplayed: value)))
  }

  /// Which constituent lens is active: 0 is the widest, incrementing past each switchover.
  public func lensIndex(forDevice deviceZoom: Double) -> Int {
    switchOverDeviceZooms.reduce(into: 0) { index, threshold in
      if deviceZoom >= threshold { index += 1 }
    }
  }

  /// Preset pills in displayed units: the minimum plus every switchover.
  ///
  /// Derived rather than hardcoded. A literal `0.5 / 1 / 2 / 5` is wrong on every non-Pro iPhone
  /// and wrong on the front camera of all of them.
  public var presetDisplayedZooms: [Double] {
    ([ minimumDeviceZoom ] + switchOverDeviceZooms).map { displayedZoom(forDevice: $0) }
  }

  /// Pinch is multiplicative against the zoom captured when the gesture began, which is what makes
  /// it track the fingers instead of drifting.
  public func pinchedDeviceZoom(from start: Double, scale: Double) -> Double {
    guard scale > 0, scale.isFinite else { return clampDeviceZoom(start) }
    return clampDeviceZoom(start * scale)
  }

  /// Picks the zoom ceiling to expose to the operator.
  ///
  /// `maxAvailableVideoZoomFactor` is the digital-upscaling limit, and on an iPhone 13 Pro it is
  /// **189** — a displayed 94.5x of almost entirely invented pixels. Handing that to a pinch gesture
  /// would make the useful part of the range a few millimetres of travel. `systemRecommendedVideoZoomRange`
  /// is Apple's own answer for what belongs on a zoom control, and on the same handset it reports
  /// 1…18 for every video format on the triple camera, i.e. 0.5x…9x displayed.
  public static func resolveMaximumDeviceZoom(recommended: Double?, available: Double) -> Double {
    guard let recommended, recommended > 1 else {
      // Single-lens cameras report no recommendation — the front camera on a 13 Pro is one. The back
      // wide-angle, which is the same class of device, recommends 1…5, so that is the fallback
      // rather than an invented number.
      return min(available, singleLensZoomFallback)
    }
    return min(recommended, available)
  }

  public static let singleLensZoomFallback: Double = 5

  /// Formats a displayed zoom the way the Camera app does: `0.5x`, `1x`, `3x`, `10x`.
  public static func label(forDisplayed displayedZoom: Double) -> String {
    let rounded = (displayedZoom * 10).rounded() / 10
    if abs(rounded - rounded.rounded()) < 0.05 {
      return "\(Int(rounded.rounded()))x"
    }
    return String(format: "%.1fx", rounded)
  }
}
