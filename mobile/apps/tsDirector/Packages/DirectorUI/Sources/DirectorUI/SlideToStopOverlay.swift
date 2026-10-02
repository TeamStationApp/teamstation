import SwiftUI

enum SlideToStopTarget {
  case stream
  case record
}

/// Compact confirm for stopping STREAMING or RECORDING. Start stays a single tap.
struct SlideToStopOverlay: View {
  private let phrase: String
  var trackIdentifier: String
  var onStop: () -> Void

  init(target: SlideToStopTarget, onStop: @escaping () -> Void) {
    switch target {
    case .stream: phrase = "Slide to Stop Stream"
    case .record: phrase = "Slide to Stop Recording"
    }
    trackIdentifier = "slide-to-stop-track"
    self.onStop = onStop
  }

  /// The broadcast track, with the words a logout row shows.
  init(
    phrase: String,
    trackIdentifier: String = "slide-to-stop-track",
    onStop: @escaping () -> Void
  ) {
    self.phrase = phrase
    self.trackIdentifier = trackIdentifier
    self.onStop = onStop
  }

  @Environment(AppEnvironment.self) private var environment
  @State private var dragOffset: CGFloat = 0
  @State private var pulseBright = false
  @State private var shimmerPhase: CGFloat = -1

  private var animateChrome: Bool { !environment.launch.isUITest }

  private static let knobSize: CGFloat = 52
  private static let trackHeight: CGFloat = 58
  /// 20% narrower than the original 340pt track so it sits under STREAM + RECORD.
  private static let trackWidth: CGFloat = 272
  /// Matches `PulsingTransportLabel` so the track overlays those rounded-square buttons.
  private static let cornerRadius: CGFloat = 8
  private static let commitFraction: CGFloat = 0.8
  private static let darkerRed = Color(red: 0.62, green: 0.08, blue: 0.10)
  private static let brighterRed = Color(red: 0.92, green: 0.18, blue: 0.20)
  private static let trackRed = Color(red: 0.78, green: 0.22, blue: 0.26)

  private var trackShape: RoundedRectangle {
    RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
  }

  var body: some View {
    track
  }

  private var track: some View {
    GeometryReader { geometry in
      let travel = max(geometry.size.width - Self.knobSize - 6, 1)
      let progress = min(max(dragOffset / travel, 0), 1)
      ZStack(alignment: .leading) {
        trackShape
          .fill(Self.trackRed.opacity(0.72))
        shimmerLabel
          // Center in the rest gap to the right of the knob, not under the knob itself.
          .padding(.leading, 3 + Self.knobSize)
          .padding(.trailing, 3)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        knob
          .offset(x: 3 + dragOffset)
        Color.clear
          .frame(width: 1, height: 1)
          .accessibilityIdentifier("slide-to-stop-end")
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
          .allowsHitTesting(false)
      }
      .contentShape(trackShape)
      .gesture(drag(travel: travel))
      .accessibilityIdentifier(trackIdentifier)
      .accessibilityValue(String(format: "%.0f percent", progress * 100))
      .onAppear { startPulse() }
    }
    .frame(width: Self.trackWidth, height: Self.trackHeight)
  }

  private var knob: some View {
    ZStack {
      RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
        .fill(pulseBright ? Self.brighterRed : Self.darkerRed)
      RoundedRectangle(cornerRadius: 2, style: .continuous)
        .fill(Color.white)
        .frame(width: 11, height: 11)
    }
    .frame(width: Self.knobSize, height: Self.knobSize)
    .shadow(color: .black.opacity(0.35), radius: 4, y: 1)
    .accessibilityIdentifier("slide-to-stop-knob")
    .accessibilityLabel(phrase)
  }

  private var shimmerLabel: some View {
    Text(phrase)
      .font(.system(size: 17, weight: .semibold, design: .rounded))
      .multilineTextAlignment(.center)
      .foregroundStyle(Color.white.opacity(0.38))
      .overlay {
        Text(phrase)
          .font(.system(size: 17, weight: .semibold, design: .rounded))
          .multilineTextAlignment(.center)
          .foregroundStyle(.white)
          .mask {
            Rectangle()
              .fill(
                LinearGradient(
                  colors: [.clear, .white, .clear],
                  startPoint: .leading,
                  endPoint: .trailing
                )
              )
              .offset(x: shimmerPhase * 130)
          }
      }
      .frame(maxWidth: .infinity)
      .clipped()
      .accessibilityIdentifier("slide-to-stop-label")
      .onAppear {
        guard animateChrome else { return }
        withAnimation(.linear(duration: 1.7).repeatForever(autoreverses: false)) {
          shimmerPhase = 1
        }
      }
  }

  private func drag(travel: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 2)
      .onChanged { value in
        dragOffset = min(max(value.translation.width, 0), travel)
      }
      .onEnded { value in
        let offset = min(max(value.translation.width, 0), travel)
        if offset / travel >= Self.commitFraction {
          dragOffset = travel
          onStop()
        } else {
          withAnimation(.spring(response: 0.28, dampingFraction: 0.78)) {
            dragOffset = 0
          }
        }
      }
  }

  private func startPulse() {
    guard animateChrome else { return }
    withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
      pulseBright = true
    }
  }
}
