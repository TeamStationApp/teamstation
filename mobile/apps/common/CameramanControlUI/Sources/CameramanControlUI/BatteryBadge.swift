import CameramanCore
import SwiftUI

/// Battery pill: a green slab with a nub on the right so it reads as a battery, the percentage in
/// white on top, turning the Low Power Mode yellow under 20 %.
///
/// `.pill` is the operating-screen size, matched to the thermal pill beside it. `.compact` is the
/// tile size in GS Director, the same footprint as its `OUT` badge. Untappable in both: on the phone
/// a zoom drag has to reach the preview underneath, and on a tile a tap has to cut to programme.
public struct BatteryBadge: View {
  public enum Style: Sendable {
    case pill
    case compact
  }

  private let status: BatteryStatus
  private let style: Style
  private let identifier: String

  public init(status: BatteryStatus, style: Style = .pill, identifier: String = "camera-battery") {
    self.status = status
    self.style = style
    self.identifier = identifier
  }

  public var body: some View {
    HStack(spacing: style == .pill ? 4 : 2) {
      if status.isCharging {
        Image(systemName: "bolt.fill")
          .font(.system(size: style == .pill ? 10 : 7, weight: .heavy))
      }
      Text(status.label)
        .font(.system(size: style == .pill ? 13 : 10, weight: .heavy, design: .rounded))
        .tracking(style == .pill ? 1 : 0)
        .monospacedDigit()
    }
    .foregroundStyle(Color.white)
    .padding(.horizontal, style == .pill ? 14 : 5)
    .padding(.vertical, style == .pill ? 8 : 2)
    .background {
      BatteryShape(cornerRadius: style == .pill ? 8 : 3, nubWidth: nubWidth)
        .fill(Color(status.hue))
    }
    // The nub sits outside the slab; reserve its width so neighbours do not overlap it.
    .padding(.trailing, nubWidth + 1)
    .accessibilityElement(children: .ignore)
    .accessibilityIdentifier(identifier)
    .accessibilityLabel("Battery")
    .accessibilityValue(status.label)
    .accessibilityAddTraits(.isStaticText)
    .allowsHitTesting(false)
  }

  private var nubWidth: CGFloat { style == .pill ? 4 : 2.5 }
}

/// A rounded slab with a small rounded nub centred on its right edge.
struct BatteryShape: Shape {
  let cornerRadius: CGFloat
  let nubWidth: CGFloat

  func path(in rect: CGRect) -> Path {
    // `rect` includes the trailing padding reserved for the nub.
    let body = CGRect(
      x: rect.minX,
      y: rect.minY,
      width: max(rect.width - nubWidth - 1, 0),
      height: rect.height
    )
    let nubHeight = rect.height * 0.42
    let nub = CGRect(
      x: body.maxX + 1,
      y: rect.midY - nubHeight / 2,
      width: nubWidth,
      height: nubHeight
    )
    var path = Path(roundedRect: body, cornerRadius: cornerRadius)
    path.addPath(Path(roundedRect: nub, cornerRadius: min(nubWidth / 2, 2)))
    return path
  }
}

extension Color {
  /// The pure packages carry colours as components; this makes them drawable.
  init(_ hue: ThermalBadgeLevel.Hue) {
    self.init(red: hue.red, green: hue.green, blue: hue.blue)
  }
}
