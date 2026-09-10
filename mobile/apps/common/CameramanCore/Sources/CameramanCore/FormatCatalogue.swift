import Foundation

/// Turns the device's raw format list into the short menu an operator should see, and picks the
/// nearest usable format for a requested resolution and frame rate.
///
/// Operates on `CaptureFormatDescriptor` rather than `AVCaptureDeviceFormat` so all of this is
/// testable with no camera present, which is the only way it can be tested on a simulator.
public struct FormatCatalogue: Sendable, Equatable {
  /// The menu, in the order it reads: 16:9 at the two rates a game is shot at, 1080p first.
  ///
  /// A device advertises dozens of sizes from 192x144 up to 4K and continuous frame-rate ranges to
  /// 240, and every combination is a choice the operator has to get right on a sideline. Director
  /// composes a 1080p programme, so anything above 1080p is battery and bandwidth spent on detail
  /// that is scaled away, anything below 720p is unwatchable in a broadcast, a 4:3 size would be
  /// cropped, and a cadence other than 30 or 60 judders in the mix. Only these four are offered;
  /// a device that lacks one simply has a shorter menu.
  public static let offeredFormats: [(width: Int, height: Int, frameRate: Double)] = [
    (1920, 1080, 60),
    (1920, 1080, 30),
    (1280, 720, 60),
    (1280, 720, 30)
  ]

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

    /// `1080p 60 fps` for a 16:9 size, which is every size the menu offers. Anything else can only
    /// arrive by launch argument or the control channel, and is spelled out so that 1440x1080 does
    /// not pass for 1080p.
    public var label: String {
      if width * 9 == height * 16 { return "\(height)p \(Int(frameRate)) fps" }
      return "\(width)x\(height) @ \(Int(frameRate))"
    }

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

  /// The offered formats this device can serve, in menu order, each reported as keeping lens
  /// switching when any format that serves it does.
  public var options: [Option] {
    Self.offeredFormats.compactMap { offered in
      let serving = formats.filter {
        $0.width == offered.width && $0.height == offered.height
          && $0.supports(frameRate: offered.frameRate)
      }
      guard !serving.isEmpty else { return nil }
      return Option(
        width: offered.width,
        height: offered.height,
        frameRate: offered.frameRate,
        supportsMultiLensSwitching: serving.contains { $0.supportsMultiLensSwitching }
      )
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
