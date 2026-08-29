import SwiftUI

/// Header thermal pill. Maps `ProcessInfo.ThermalState` to the operator-facing word, hue, and
/// motion — not the HUD's `nominal` / `fair` / `serious` / `critical` names.
public enum ThermalBadgeLevel: String, CaseIterable, Sendable {
  case cool
  case fair
  case warm
  case hot

  public enum Shimmer: Sendable, Equatable {
    case pulse
    case up
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

  public var hue: Color {
    switch self {
    case .cool: .sourceBlue
    case .fair: Color(red: 0.98, green: 0.84, blue: 0.18)
    case .warm: Color(red: 0.98, green: 0.52, blue: 0.12)
    case .hot: .recordRed
    }
  }
}

/// Untappable chrome pill. Hits do nothing and do not fall through to Recordings.
struct ThermalBadge: View {
  let level: ThermalBadgeLevel
  var animate: Bool

  var body: some View {
    Group {
      if animate {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: false)) { context in
          chrome(phase: phase(at: context.date))
        }
      } else {
        chrome(phase: 0.35)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityIdentifier("header-thermal")
    .accessibilityLabel("Thermal")
    .accessibilityValue(level.rawValue)
    .accessibilityAddTraits(.isStaticText)
  }

  private func phase(at date: Date) -> Double {
    let cycle = max(level.cycleSeconds, 0.01)
    let elapsed = date.timeIntervalSinceReferenceDate
    let wrapped = elapsed.truncatingRemainder(dividingBy: cycle)
    return (wrapped < 0 ? wrapped + cycle : wrapped) / cycle
  }

  private func chrome(phase: Double) -> some View {
    HStack(spacing: 8) {
      if level.showsFlames {
        Text("🔥")
      }
      Text(level.label)
        .font(.system(size: 13, weight: .heavy, design: .rounded))
        .tracking(1)
      if level.showsFlames {
        Text("🔥")
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .background {
      ThermalShimmerBackground(color: level.hue, shimmer: level.shimmer, phase: phase)
    }
    .foregroundStyle(Color.white)
  }
}

/// Darkest fill. Cool / fair / warm pulse it between 0.18 and 0.38. Hot travels a ¾-height
/// gradient slab that enters the bottom and fully exits the top.
private struct ThermalShimmerBackground: View {
  let color: Color
  let shimmer: ThermalBadgeLevel.Shimmer
  let phase: Double

  private static let fillOpacity = 0.18
  private static let bandOpacity = 0.38
  private static let bandFraction = 0.75
  /// Fade each end of the slab over this fraction of the **pill** height.
  private static let fadePillFraction = 0.20

  var body: some View {
    RoundedRectangle(cornerRadius: 8)
      .fill(color.opacity(fillOpacity))
      .overlay {
        if shimmer != .pulse {
          GeometryReader { geo in
            let pillHeight = geo.size.height
            let bandHeight = pillHeight * Self.bandFraction
            slab(pillHeight: pillHeight, bandHeight: bandHeight)
              .frame(width: geo.size.width)
              .offset(y: bandTop(pillHeight: pillHeight, bandHeight: bandHeight))
          }
          .clipShape(RoundedRectangle(cornerRadius: 8))
        }
      }
  }

  private var fillOpacity: Double {
    guard shimmer == .pulse else { return Self.fillOpacity }
    let t = 0.5 - 0.5 * cos(phase * 2 * Double.pi)
    return Self.fillOpacity + (Self.bandOpacity - Self.fillOpacity) * t
  }

  /// Hot: top of the slab enters from the bottom; cycle ends when the bottom has left the top.
  private func bandTop(pillHeight: CGFloat, bandHeight: CGFloat) -> CGFloat {
    let travel = pillHeight + bandHeight
    switch shimmer {
    case .up:
      return pillHeight - CGFloat(phase) * travel
    case .pulse:
      return 0
    }
  }

  private func slab(pillHeight: CGFloat, bandHeight: CGFloat) -> some View {
    let fadeUnit = bandHeight > 0
      ? min(0.49, (Self.fadePillFraction * pillHeight) / bandHeight)
      : 0
    return Rectangle()
      .fill(
        LinearGradient(
          stops: [
            .init(color: color.opacity(0), location: 0),
            .init(color: color.opacity(Self.bandOpacity), location: fadeUnit),
            .init(color: color.opacity(Self.bandOpacity), location: 1 - fadeUnit),
            .init(color: color.opacity(0), location: 1)
          ],
          startPoint: .top,
          endPoint: .bottom
        )
      )
      .frame(height: bandHeight)
  }
}
