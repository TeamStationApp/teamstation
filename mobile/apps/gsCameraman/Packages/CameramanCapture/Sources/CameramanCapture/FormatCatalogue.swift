import CameramanCore
import Foundation

/// Turns the device's raw format list into the short menu an operator should see, and picks the
/// nearest usable format for a requested resolution and frame rate.
///
/// Operates on `CaptureFormatDescriptor` rather than `AVCaptureDeviceFormat` so all of this is
/// testable with no camera present, which is the only way it can be tested on a simulator.
public struct FormatCatalogue: Sendable, Equatable {
  /// The frame rates worth offering. A device advertises continuous ranges, so without a curated
  /// list the menu would contain every integer from 1 to 240.
  public static let candidateFrameRates: [Double] = [ 24, 25, 30, 50, 60, 120, 240 ]

  public struct Option: Sendable, Equatable, Hashable {
    public let width: Int
    public let height: Int
    public let frameRate: Double
    public let supportsMultiLensSwitching: Bool

    public init(width: Int, height: Int, frameRate: Double, supportsMultiLensSwitching: Bool) {
      self.width = width
      self.height = height
      self.frameRate = frameRate
      self.supportsMultiLensSwitching = supportsMultiLensSwitching
    }

    public var label: String { "\(width)x\(height) @ \(Int(frameRate))" }

    /// Shown in the settings list so losing lens switching is a visible trade-off rather than a
    /// silent one.
    public var annotation: String? {
      supportsMultiLensSwitching ? nil : "single lens only"
    }
  }

  public let formats: [CaptureFormatDescriptor]

  public init(formats: [CaptureFormatDescriptor]) {
    self.formats = formats
  }

  /// One entry per resolution and frame rate, keeping the variant that preserves lens switching
  /// when the device offers both.
  public var options: [Option] {
    var best: [Option: Bool] = [:]
    for format in formats {
      for rate in Self.candidateFrameRates where format.supports(frameRate: rate) {
        let key = Option(
          width: format.width,
          height: format.height,
          frameRate: rate,
          supportsMultiLensSwitching: false
        )
        best[key] = (best[key] ?? false) || format.supportsMultiLensSwitching
      }
    }
    return best
      .map {
        Option(
          width: $0.key.width,
          height: $0.key.height,
          frameRate: $0.key.frameRate,
          supportsMultiLensSwitching: $0.value
        )
      }
      .sorted {
        if $0.width * $0.height != $1.width * $1.height {
          return $0.width * $0.height < $1.width * $1.height
        }
        return $0.frameRate < $1.frameRate
      }
  }

  /// The nearest usable format for a request.
  ///
  /// Preference order is deliberate: exact dimensions first, then a format that keeps lens
  /// switching, then the tightest frame-rate range that still contains the request. Preferring the
  /// tightest range matters because a 240 fps format run at 30 wastes power and often drops
  /// switching, while the 30 fps format does neither.
  public func selection(width: Int, height: Int, frameRate: Double) -> CaptureFormatDescriptor? {
    guard !formats.isEmpty else { return nil }

    let ranked = formats.sorted { left, right in
      let leftExact = left.width == width && left.height == height
      let rightExact = right.width == width && right.height == height
      if leftExact != rightExact { return leftExact }

      let leftRate = left.supports(frameRate: frameRate)
      let rightRate = right.supports(frameRate: frameRate)
      if leftRate != rightRate { return leftRate }

      if left.supportsMultiLensSwitching != right.supportsMultiLensSwitching {
        return left.supportsMultiLensSwitching
      }

      let leftDistance = abs(left.pixelCount - width * height)
      let rightDistance = abs(right.pixelCount - width * height)
      if leftDistance != rightDistance { return leftDistance < rightDistance }

      return left.maximumFrameRate < right.maximumFrameRate
    }
    return ranked.first
  }

  /// 1080p30 keeping lens switching, which is the documented default.
  public var defaultSelection: CaptureFormatDescriptor? {
    selection(width: 1920, height: 1080, frameRate: 30)
  }

  /// The highest resolution and frame rate the device offers, whether or not it keeps switching.
  public var maximumSelection: CaptureFormatDescriptor? {
    formats.max {
      if $0.pixelCount != $1.pixelCount { return $0.pixelCount < $1.pixelCount }
      return $0.maximumFrameRate < $1.maximumFrameRate
    }
  }
}
