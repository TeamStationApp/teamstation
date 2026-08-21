import SwiftUI

/// Two-row instant-replay controls. Hits stay on the buttons so a tap cannot cut the camera
/// to Output and a drag cannot start a scrub.
struct ReplayHotkeyBar: View {
  let tileIndex: Int
  let accessibilityPrefix: String
  let slowMotionRate: Double
  let onReplay: (Double, Float) -> Void

  private static let offsets: [Double] = [2.5, 5, 7.5, 10]

  var body: some View {
    VStack(spacing: 4) {
      row(rate: 1, label: { Self.format($0) })
      row(rate: Float(slowMotionRate), label: { "\(Self.format($0))×\(Self.format(slowMotionRate))" })
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 5)
    .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 6))
  }

  private func row(rate: Float, label: @escaping (Double) -> String) -> some View {
    HStack(spacing: 4) {
      ForEach(Self.offsets, id: \.self) { seconds in
        Button {
          onReplay(seconds, rate)
        } label: {
          Text(label(seconds))
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
            .background(Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier(seconds: seconds, rate: rate))
      }
    }
  }

  private func identifier(seconds: Double, rate: Float) -> String {
    let amount = seconds == 2.5 ? "2.5" : String(Int(seconds))
    if rate == 1 {
      return "\(accessibilityPrefix)-replay-\(amount)"
    }
    return "\(accessibilityPrefix)-replay-slow-\(amount)"
  }

  private static func format(_ value: Double) -> String {
    if value == value.rounded() { return String(Int(value)) }
    return String(format: "%g", value)
  }
}

struct InstantReplayCaption: View {
  let accessibilityIdentifier: String

  var body: some View {
    Text("INSTANT REPLAY")
      .font(.system(size: 13, weight: .heavy, design: .rounded))
      .foregroundStyle(.white)
      .shadow(color: .black.opacity(0.85), radius: 2, x: 0, y: 1)
      .accessibilityIdentifier(accessibilityIdentifier)
  }
}
