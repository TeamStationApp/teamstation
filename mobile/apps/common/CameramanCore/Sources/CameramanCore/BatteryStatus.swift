import Foundation

/// The phone's battery, as the overlay pill and the wire show it.
///
/// Pure so the remote client decodes `system.battery` into the same value the phone draws, and so
/// the colour threshold is unit-tested with no UIKit in the process. The phone fills it from
/// `UIDevice`; a simulator reports no battery and gets nil, in which case nothing is drawn.
public struct BatteryStatus: Sendable, Equatable, Codable {
  /// 0…100.
  public var percent: Int
  public var isCharging: Bool

  /// Below this the pill turns the dark yellow iOS uses for Low Power Mode.
  public static let lowThresholdPercent = 20

  public init(percent: Int, isCharging: Bool = false) {
    self.percent = min(max(percent, 0), 100)
    self.isCharging = isCharging
  }

  /// From `UIDevice.batteryLevel`, which is 0…1 or negative when unknown.
  public init?(level: Double, isCharging: Bool) {
    guard level.isFinite, level >= 0 else { return nil }
    self.init(percent: Int((level * 100).rounded()), isCharging: isCharging)
  }

  public var isLow: Bool { percent < Self.lowThresholdPercent }

  public var label: String { "\(percent)%" }

  /// Green, or the Low Power Mode yellow once it dips under the threshold.
  public var hue: ThermalBadgeLevel.Hue {
    isLow
      ? ThermalBadgeLevel.Hue(red: 0.85, green: 0.66, blue: 0.08)
      : ThermalBadgeLevel.Hue(red: 0.20, green: 0.78, blue: 0.35)
  }
}
