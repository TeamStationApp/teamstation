import CameramanCore
import SwiftUI

private enum BroadcastChrome {
  static let recordRed = Color(red: 0.95, green: 0.24, blue: 0.28)
  static let darkerRed = Color(red: 0.78, green: 0.16, blue: 0.18)
  static let brighterRed = Color(red: 1.0, green: 0.32, blue: 0.36)
  /// Idle record disc: darker and less saturated than the live red.
  static let idleRecordRed = Color(red: 0.55, green: 0.23, blue: 0.25)
  /// Idle center mark, a step off pure white.
  static let idleRecordMark = Color(red: 0.90, green: 0.89, blue: 0.886)
  static let knob: CGFloat = 52
  static let trackWidth: CGFloat = 272
  static let trackHeight: CGFloat = 58
  /// Corner of an iPhone app icon, as a fraction of the icon's side.
  static let appIconCornerFraction: CGFloat = 0.28
  static var trackCorner: CGFloat { (trackHeight * appIconCornerFraction).rounded() }
  static var knobCorner: CGFloat { (knob * appIconCornerFraction).rounded() }
}

/// Idle disc is a muted red with a gray-white circle. Live, it is the bright record red with a white square.
struct BroadcastButton: View {
  let isLive: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        Circle()
          .fill(isLive ? BroadcastChrome.recordRed : BroadcastChrome.idleRecordRed)
          .frame(width: 64, height: 64)
        if isLive {
          RoundedRectangle(cornerRadius: 3, style: .continuous)
            .fill(Color.white)
            .frame(width: 20, height: 20)
        } else {
          Circle()
            .fill(BroadcastChrome.idleRecordMark)
            .frame(width: 24, height: 24)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("broadcast-button")
    .accessibilityLabel(isLive ? "Stop broadcasting" : "Start broadcasting")
  }
}

/// Pulsing red pill, drawn to the left of the thermal badge while a broadcast is on.
struct BroadcastingPill: View {
  let animate: Bool
  @State private var pulseBright = false

  var body: some View {
    HStack(spacing: 8) {
      RoundedRectangle(cornerRadius: 2, style: .continuous)
        .fill(Color.white)
        .frame(width: 11, height: 11)
      Text("Broadcasting")
        .font(.system(size: 13, weight: .heavy, design: .rounded))
        .tracking(1)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background(pulseBright ? BroadcastChrome.brighterRed : BroadcastChrome.darkerRed, in: RoundedRectangle(cornerRadius: 8))
    .foregroundStyle(.white)
    .accessibilityIdentifier("broadcasting-pill")
    .accessibilityLabel("Broadcasting")
    .onAppear {
      guard animate else { return }
      withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
        pulseBright = true
      }
    }
  }
}

/// Confirm a stop. Start stays one tap. The knob commits at `BroadcastPolicy.slideCommitFraction`.
struct SlideToStop: View {
  let animate: Bool
  let onStop: () -> Void

  @State private var dragOffset: CGFloat = 0
  @State private var pulseBright = false

  var body: some View {
    GeometryReader { geometry in
      let travel = max(geometry.size.width - BroadcastChrome.knob - 6, 1)
      let progress = min(max(dragOffset / travel, 0), 1)
      ZStack(alignment: .leading) {
        RoundedRectangle(cornerRadius: BroadcastChrome.trackCorner, style: .continuous)
          .fill(BroadcastChrome.recordRed.opacity(0.72))
        Text("Slide to Stop")
          .font(.system(size: 17, weight: .semibold, design: .rounded))
          .foregroundStyle(.white)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .padding(.leading, 3 + BroadcastChrome.knob)
          .padding(.trailing, 8)
          .accessibilityIdentifier("slide-to-stop-label")
        ZStack {
          RoundedRectangle(cornerRadius: BroadcastChrome.knobCorner, style: .continuous)
            .fill(pulseBright ? BroadcastChrome.brighterRed : BroadcastChrome.darkerRed)
          RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(Color.white)
            .frame(width: 11, height: 11)
        }
        .frame(width: BroadcastChrome.knob, height: BroadcastChrome.knob)
        .offset(x: 3 + dragOffset)
        .accessibilityIdentifier("slide-to-stop-knob")
        .accessibilityLabel("Slide to Stop")
        Color.clear
          .frame(width: 1, height: 1)
          .accessibilityIdentifier("slide-to-stop-end")
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
          .allowsHitTesting(false)
      }
      .contentShape(RoundedRectangle(cornerRadius: BroadcastChrome.trackCorner, style: .continuous))
      .gesture(drag(travel: travel))
      .accessibilityIdentifier("slide-to-stop-track")
      .accessibilityValue(String(format: "%.0f percent", progress * 100))
      .onAppear {
        guard animate else { return }
        withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
          pulseBright = true
        }
      }
    }
    .frame(width: BroadcastChrome.trackWidth, height: BroadcastChrome.trackHeight)
  }

  private func drag(travel: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 2)
      .onChanged { value in
        dragOffset = min(max(value.translation.width, 0), travel)
      }
      .onEnded { value in
        let offset = min(max(value.translation.width, 0), travel)
        if BroadcastPolicy.slideCommits(progress: Double(offset / travel)) {
          dragOffset = travel
          onStop()
        } else {
          withAnimation(.spring(response: 0.28, dampingFraction: 0.78)) {
            dragOffset = 0
          }
        }
      }
  }
}
