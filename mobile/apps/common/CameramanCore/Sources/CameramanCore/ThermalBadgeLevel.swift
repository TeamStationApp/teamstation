import Foundation

/// The operator-facing thermal word, hue, and motion behind the overlay pill.
///
/// Maps `ProcessInfo.ThermalState` (and dump-state's `nominal` / `fair` / `serious` / `critical`
/// names) to Cool / Fair / Warm / Hot. Lives in the pure package so a remote client can decode the
/// phone's `system.thermal` parameter into the same level the phone draws, and so the mapping is
/// unit-tested with no SwiftUI in the process.
public enum ThermalBadgeLevel: String, CaseIterable, Sendable {
  case cool
  case fair
  case warm
  case hot

  public enum Shimmer: Sendable, Equatable {
    case pulse
    case up
  }

  /// sRGB components in 0…1. A tuple-like value rather than a `Color` so this enum needs no SwiftUI;
  /// the UI package turns it into one.
  public struct Hue: Sendable, Equatable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(red: Double, green: Double, blue: Double) {
      self.red = red
      self.green = green
      self.blue = blue
    }
  }

  public init(process: ProcessInfo.ThermalState) {
    switch process {
    case .nominal: self = .cool
    case .fair: self = .fair
    case .serious: self = .warm
    case .critical: self = .hot
    @unknown default: self = .cool
    }
  }

  public init(telemetryName: String) {
    switch telemetryName {
    case "fair": self = .fair
    case "serious": self = .warm
    case "critical": self = .hot
    default: self = .cool
    }
  }

  public var processState: ProcessInfo.ThermalState {
    switch self {
    case .cool: .nominal
    case .fair: .fair
    case .warm: .serious
    case .hot: .critical
    }
  }

  /// RECORD/STREAM-style caps. Accessibility value stays the lowercase `rawValue`.
  public var label: String { rawValue.uppercased() }

  public var showsFlames: Bool { self == .hot }

  public var shimmer: Shimmer {
    switch self {
    case .cool, .fair, .warm: .pulse
    case .hot: .up
    }
  }

  /// Seconds for one cycle: fill pulse, or enter-to-exit travel for hot.
  public var cycleSeconds: Double {
    switch self {
    case .cool, .fair: 3
    case .warm: 2
    case .hot: 1
    }
  }

  /// Cool is TS Director's source blue and hot its record red, so the pill reads the same in every
  /// app that shows it.
  public var hue: Hue {
    switch self {
    case .cool: Hue(red: 0.18, green: 0.48, blue: 0.95)
    case .fair: Hue(red: 0.98, green: 0.84, blue: 0.18)
    case .warm: Hue(red: 0.98, green: 0.52, blue: 0.12)
    case .hot: Hue(red: 0.95, green: 0.24, blue: 0.28)
    }
  }
}
