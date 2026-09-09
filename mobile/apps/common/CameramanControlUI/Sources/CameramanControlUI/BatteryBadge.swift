import CameramanCore
import SwiftUI

/// Battery pill: a green slab with a nub on the right so it reads as a battery, the percentage in
/// white on top, turning the Low Power Mode yellow under 20 %.
///
/// `.pill` is the operating-screen size, matched to the thermal pill beside it. `.compact` is the
/// tile size in GS Director, one header row tall beside the loss pill. Untappable in both: on the phone
/// a zoom drag has to reach the preview underneath, and on a tile a tap has to cut to programme.
///
/// Both sizes are laid out against the widest state the pill can ever show — the bolt beside
/// `100%` — rather than against whatever is on screen right now. The rows it sits in are tight
/// (Cameraman's chrome column, Director's tile header next to a source name), and a pill sized to
/// its current contents gets squeezed there: the label wraps onto a second line and the slab grows
/// tall instead of wide. Reserving the worst case keeps it one line always, and stops the pill
/// resizing as the percentage counts down or the charger comes and goes.
public struct BatteryBadge: View {
  public enum Style: Sendable {
    case pill
    case compact
  }

  private let status: BatteryStatus
  private let style: Style
  private let identifier: String

  /// The widest the label ever gets. Read off `BatteryStatus` so the reservation cannot drift from
  /// the format the pill actually draws.
  private static let widestLabel = BatteryStatus(percent: 100).label

  public init(status: BatteryStatus, style: Style = .pill, identifier: String = "camera-battery") {
    self.status = status
    self.style = style
    self.identifier = identifier
  }

  public var body: some View {
    ZStack {
      contents(label: Self.widestLabel, isCharging: true).hidden()
      contents(label: status.label, isCharging: status.isCharging)
    }
    // The reservation is only worth having if the pill refuses to be compressed below it.
    .fixedSize()
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

  /// The bolt and the percentage. Drawn twice: once hidden at its widest to fix the pill's size,
  /// once for real. Monospaced digits make `100%` the widest label rather than merely the longest.
  private func contents(label: String, isCharging: Bool) -> some View {
    HStack(spacing: style == .pill ? 4 : 2) {
      if isCharging {
        Image(systemName: "bolt.fill")
          .font(.system(size: style == .pill ? 10 : 7, weight: .heavy))
      }
      Text(label)
        .font(.system(size: style == .pill ? 13 : 10, weight: .heavy, design: .rounded))
        .tracking(style == .pill ? 1 : 0)
        .monospacedDigit()
        .lineLimit(1)
    }
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
