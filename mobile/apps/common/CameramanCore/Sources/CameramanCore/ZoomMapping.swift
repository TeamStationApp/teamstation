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
  /// Device zoom where the camera's own range ends and Cameraman's software zoom begins. Everything
  /// above it, up to `maximumDeviceZoom`, is drawn in yellow. Nil when there is no software range.
  public let softwareZoomStartDeviceZoom: Double?

  public init(
    minimumDeviceZoom: Double = 1,
    maximumDeviceZoom: Double,
    displayMultiplier: Double = 1,
    switchOverDeviceZooms: [Double] = [],
    softwareZoomStartDeviceZoom: Double? = nil
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
    // At the minimum is allowed: a camera with no zoom of its own is software from end to end.
    self.softwareZoomStartDeviceZoom = softwareZoomStartDeviceZoom.flatMap {
      $0 >= minimum && $0 < maximum ? $0 : nil
    }
  }

  /// This mapping with a software range of `softwareZoomExtension` on top of its ceiling, or itself
  /// when it already has one. What Director adds for a camera that does not zoom past its own
  /// limit, and, from a single fixed zoom, the whole range of a camera with no zoom at all.
  public func extendedBySoftwareZoom() -> ZoomMapping {
    guard softwareZoomStartDeviceZoom == nil else { return self }
    return ZoomMapping(
      minimumDeviceZoom: minimumDeviceZoom,
      maximumDeviceZoom: maximumDeviceZoom * Self.softwareZoomExtension,
      displayMultiplier: displayMultiplier,
      switchOverDeviceZooms: switchOverDeviceZooms,
      softwareZoomStartDeviceZoom: maximumDeviceZoom
    )
  }

  /// The camera's ceiling in displayed units: where the software range starts, or the maximum.
  public var softwareZoomStartDisplayedZoom: Double? {
    softwareZoomStartDeviceZoom.map { displayedZoom(forDevice: $0) }
  }

  /// The optical stops in displayed units: the widest lens and each lens switchover. Everything past
  /// the last of them is digital, whether the camera or Cameraman does the cropping.
  public var opticalDisplayedZooms: [Double] {
    ([ minimumDeviceZoom ] + switchOverDeviceZooms).map { displayedZoom(forDevice: $0) }
  }

  /// True past the longest lens: the camera's own digital zoom and Cameraman's software zoom both.
  /// What the rail draws in yellow, so an operator can see which stops are the lenses.
  public func isDigitalZoom(displayed displayedZoom: Double) -> Bool {
    guard let longest = opticalDisplayedZooms.last else { return false }
    return Self.label(forDisplayed: displayedZoom) != Self.label(forDisplayed: longest) && displayedZoom > longest
  }

  /// True for a scale segment that starts at or past the longest lens.
  public func isDigitalSegment(_ segment: Int) -> Bool {
    let presets = presetDisplayedZooms
    guard segment >= 0, segment + 1 < presets.count else { return false }
    return isDigitalZoom(displayed: presets[segment + 1])
  }

  /// True above the camera's own ceiling, where only Cameraman's software zoom reaches.
  public func isSoftwareZoom(displayed displayedZoom: Double) -> Bool {
    guard let start = softwareZoomStartDisplayedZoom else { return false }
    return Self.label(forDisplayed: displayedZoom) != Self.label(forDisplayed: start) && displayedZoom > start
  }

  /// True for the scale segment that runs from the camera's ceiling to the software maximum.
  public func isSoftwareSegment(_ segment: Int) -> Bool {
    let presets = presetDisplayedZooms
    guard softwareZoomStartDeviceZoom != nil, segment >= 0, segment + 1 < presets.count else { return false }
    return isSoftwareZoom(displayed: presets[segment + 1]) && !isSoftwareZoom(displayed: presets[segment])
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

  /// Preset pills in displayed units: one per lens (the minimum and every lens switchover), then the
  /// camera's digital ceiling, then Cameraman's software maximum.
  ///
  /// The lens pills are the optical stops and nothing else, so an operator aiming to avoid digital
  /// zoom can land on one. Native sensor crops (a 48 MP lens's 2x) are not lenses and get no pill.
  ///
  /// The far-right mark is the zoom ceiling even when that value is digital rather than a
  /// constituent lens. On an iPhone 13 Pro that is 9x. A literal `0.5 / 1 / 2 / 5` is wrong on
  /// every non-Pro iPhone and wrong on the front camera of all of them.
  ///
  /// With a software range, the camera's ceiling is a pill of its own and the software maximum sits
  /// above it, so the last segment is exactly the software zoom.
  public var presetDisplayedZooms: [Double] {
    var marks = opticalDisplayedZooms
    let ceilings = [ softwareZoomStartDeviceZoom, maximumDeviceZoom ].compactMap { $0 }
    for ceiling in ceilings {
      let value = displayedZoom(forDevice: ceiling)
      if let last = marks.last, Self.label(forDisplayed: value) == Self.label(forDisplayed: last) { continue }
      marks.append(value)
    }
    return marks
  }

  /// Pinch is multiplicative against the zoom captured when the gesture began, which is what makes
  /// it track the fingers instead of drifting.
  public func pinchedDeviceZoom(from start: Double, scale: Double) -> Double {
    guard scale > 0, scale.isFinite else { return clampDeviceZoom(start) }
    return clampDeviceZoom(start * scale)
  }

  /// How far along the drawn scale a displayed zoom sits, 0 at the widest pill and 1 at the tightest.
  ///
  /// Segments are equal in *screen* space, not in zoom ratio: 0.5x→1x, 1x→3x and 3x→9x each occupy
  /// a third of the column on a 13 Pro. A drag that covers one pill-to-pill gap therefore walks one
  /// of those segments, which is the contract for the full-screen scrub.
  public func scaleProgress(forDisplayed displayedZoom: Double) -> Double {
    let presets = presetDisplayedZooms
    let zoom = clampDisplayedZoom(displayedZoom)
    guard presets.count >= 2 else { return 0 }
    if zoom <= presets[0] { return 0 }
    let last = presets.count - 1
    if zoom >= presets[last] { return 1 }
    let segments = Double(last)
    for index in 0..<last {
      let lo = presets[index]
      let hi = presets[index + 1]
      guard hi > lo, zoom >= lo, zoom <= hi else { continue }
      return (Double(index) + (zoom - lo) / (hi - lo)) / segments
    }
    return 1
  }

  public func displayedZoom(forScaleProgress progress: Double) -> Double {
    let presets = presetDisplayedZooms
    guard let first = presets.first else { return 1 }
    guard presets.count >= 2 else { return first }
    let clamped = min(max(progress, 0), 1)
    let scaled = clamped * Double(presets.count - 1)
    var index = Int(scaled)
    if index >= presets.count - 1 { index = presets.count - 2 }
    let t = scaled - Double(index)
    return presets[index] + (presets[index + 1] - presets[index]) * t
  }

  /// Relative scrub along the scale. `draggedPoints` is up-positive; a drag equal to
  /// `pointsPerSegment` moves from one pill to the next.
  public func displayedZoom(
    draggingFrom start: Double,
    byPoints draggedPoints: Double,
    pointsPerSegment: Double
  ) -> Double {
    guard draggedPoints.isFinite, pointsPerSegment > 0, pointsPerSegment.isFinite else {
      return clampDisplayedZoom(start)
    }
    let segments = Double(max(scaleSegmentCount, 1))
    let progress = scaleProgress(forDisplayed: start) + draggedPoints / (pointsPerSegment * segments)
    return clampDisplayedZoom(displayedZoom(forScaleProgress: progress))
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

  /// How far past the camera's recommended ceiling Cameraman's software zoom reaches: 9x becomes 18x
  /// on a 15 Pro.
  public static let softwareZoomExtension: Double = 2

  /// Formats a displayed zoom the way the Camera app does: `0.5x`, `1x`, `3x`, `10x`.
  public static func label(forDisplayed displayedZoom: Double) -> String {
    let rounded = (displayedZoom * 10).rounded() / 10
    if abs(rounded - rounded.rounded()) < 0.05 {
      return "\(Int(rounded.rounded()))x"
    }
    return String(format: "%.1fx", rounded)
  }

  /// Zoom-rail labels. At 1x and above, the nearest whole number. Below 1x the tenth stays.
  public static func sliderLabel(forDisplayed displayedZoom: Double) -> String {
    if displayedZoom < 1 { return label(forDisplayed: displayedZoom) }
    return "\(Int(displayedZoom.rounded()))x"
  }

  /// Tick marks drawn between each pair of lens presets.
  public static let scaleTicksPerSegment = 5

  /// Which mark on the zoom scale should light up for a displayed zoom.
  ///
  /// A preset lights when the rounded label matches that lens (`1.04` still reads `1x`). Anything
  /// else lights one of the five bars in the segment that contains it, so a pinch between 1x and 3x
  /// is never a row of identical dark marks.
  public enum ScaleHighlight: Sendable, Equatable {
    case preset(Double)
    case tick(segment: Int, index: Int)
  }

  public var scaleSegmentCount: Int {
    max(presetDisplayedZooms.count - 1, 0)
  }

  public func scaleHighlight(forDisplayed displayedZoom: Double) -> ScaleHighlight {
    let zoom = clampDisplayedZoom(displayedZoom)
    let presets = presetDisplayedZooms
    guard let last = presets.last else { return .preset(zoom) }

    if let match = presets.first(where: { Self.label(forDisplayed: zoom) == Self.label(forDisplayed: $0) }) {
      return .preset(match)
    }

    guard scaleSegmentCount > 0 else { return .preset(last) }

    if zoom >= last {
      return .tick(segment: scaleSegmentCount - 1, index: Self.scaleTicksPerSegment - 1)
    }

    for (segment, hi) in presets.dropFirst().enumerated() {
      let lo = presets[segment]
      guard zoom >= lo, zoom < hi, hi > lo else { continue }
      // Work in thousandths so 0.7 − 0.5 does not become 0.199999 and land on the wrong bar.
      let milli = Int((zoom * 1000).rounded())
      let loMilli = Int((lo * 1000).rounded())
      let hiMilli = Int((hi * 1000).rounded())
      let span = hiMilli - loMilli
      guard span > 0 else { continue }
      var index = (milli - loMilli) * Self.scaleTicksPerSegment / span
      if index >= Self.scaleTicksPerSegment { index = Self.scaleTicksPerSegment - 1 }
      if index < 0 { index = 0 }
      return .tick(segment: segment, index: index)
    }

    return .preset(last)
  }
}
