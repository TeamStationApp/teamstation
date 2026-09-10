import CameramanCore
import SwiftUI

extension ThermalBadgeLevel {
  /// The pill colour. `Color` is SwiftUI, so the pure enum carries components and this makes them
  /// drawable.
  public var color: Color { Color(hue) }
}

/// Untappable chrome pill showing Cool / Fair / Warm / Hot with the same motion in every app.
///
/// Cameraman lets hits pass through so a zoom drag still reaches the preview underneath; Director
/// swallows them so a tap on the header pill does not fall through to Recordings. The identifier
/// differs per host (`camera-thermal` on the operating screen, `header-thermal` in Director's
/// toolbar) so each app's existing flows keep finding it. `.compact` is the tile size in
/// Director, one header row tall beside the loss pill, for a Cameraman source's own thermal state.
public struct ThermalBadge: View {
  public enum Style: Sendable {
    case pill
    case compact
  }

  private let level: ThermalBadgeLevel
  private let animate: Bool
  private let identifier: String
  private let passesTouches: Bool
  private let style: Style

  public init(
    level: ThermalBadgeLevel,
    animate: Bool,
    identifier: String = "camera-thermal",
    passesTouches: Bool = true,
    style: Style = .pill
  ) {
    self.level = level
    self.animate = animate
    self.identifier = identifier
    self.passesTouches = passesTouches
    self.style = style
  }

  public var body: some View {
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
    .accessibilityIdentifier(identifier)
    .accessibilityLabel("Thermal")
    .accessibilityValue(level.rawValue)
    .accessibilityAddTraits(.isStaticText)
    .allowsHitTesting(!passesTouches)
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
        .font(.system(size: style == .pill ? 13 : 10, weight: .heavy, design: .rounded))
        .tracking(style == .pill ? 1 : 0)
        .lineLimit(1)
      if level.showsFlames {
        Text("🔥")
      }
    }
    .font(.system(size: style == .pill ? 13 : 10))
    // Same reason as the battery pill it sits beside: the rows these live in run short of width,
    // and a pill that gives way there wraps its label and grows tall instead of wide.
    .fixedSize()
    .padding(.horizontal, style == .pill ? 16 : 5)
    .padding(.vertical, style == .pill ? 8 : 2)
    .background {
      ThermalShimmerBackground(
        color: level.color,
        shimmer: level.shimmer,
        phase: phase,
        cornerRadius: style == .pill ? 8 : 3
      )
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
  var cornerRadius: CGFloat = 8

  private static let fillOpacity = 0.18
  private static let bandOpacity = 0.38
  private static let bandFraction = 0.75
  /// Fade each end of the slab over this fraction of the **pill** height.
  private static let fadePillFraction = 0.20

  var body: some View {
    RoundedRectangle(cornerRadius: cornerRadius)
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
          .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
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
