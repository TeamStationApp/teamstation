import SwiftUI

/// Visible titles on the instant-replay buttons. Kept free of SwiftUI so the format is unit
/// testable without a host.
public enum ReplayHotkeyFormatting {
  public static func secondsToken(_ seconds: Double) -> String {
    if seconds == seconds.rounded() { return String(Int(seconds)) }
    return String(format: "%g", seconds)
  }

  public static func fullSpeedTitle(_ seconds: Double) -> String {
    "\(secondsToken(seconds))s"
  }

  public static func slowMotionTitle(_ seconds: Double, rate: Double) -> String {
    let percent = Int((rate * 100).rounded())
    return "\(fullSpeedTitle(seconds)) @ \(percent)%"
  }
}

/// Two-row instant-replay controls. Hits stay on the buttons so a tap cannot cut the camera
/// to Output and a drag cannot start a scrub.
struct ReplayHotkeyBar: View {
  let sourceIndex: Int
  let accessibilityPrefix: String
  let slowMotionRate: Double
  let onReplay: (Double, Float) -> Void

  private static let offsets: [Double] = [5, 7.5, 10]

  var body: some View {
    VStack(spacing: 4) {
      row(rate: 1, title: ReplayHotkeyFormatting.fullSpeedTitle)
      row(rate: Float(slowMotionRate)) { seconds in
        ReplayHotkeyFormatting.slowMotionTitle(seconds, rate: slowMotionRate)
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 5)
    .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 6))
  }

  private func row(rate: Float, title: @escaping (Double) -> String) -> some View {
    HStack(spacing: 4) {
      ForEach(Self.offsets, id: \.self) { seconds in
        Button {
          onReplay(seconds, rate)
        } label: {
          HStack(spacing: 3) {
            Image(systemName: "arrow.counterclockwise")
              .font(.system(size: 10, weight: .bold))
            Text(title(seconds))
              .font(.system(size: 11, weight: .bold, design: .rounded))
              .minimumScaleFactor(0.7)
              .lineLimit(1)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
          .background(Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
          .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier(seconds: seconds, rate: rate))
      }
    }
  }

  private func identifier(seconds: Double, rate: Float) -> String {
    let amount = ReplayHotkeyFormatting.secondsToken(seconds)
    if rate == 1 {
      return "\(accessibilityPrefix)-replay-\(amount)"
    }
    return "\(accessibilityPrefix)-replay-slow-\(amount)"
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
