import SpeedyCore
import SwiftUI
import UIKit

/// The whole screen: pitch above the line, exit below it, a gear for Settings and the audio switch.
struct ReadoutView: View {
  @Bindable var model: SpeedyModel
  /// Bumped when a side's five seconds run out, so the screen redraws then; a reading redraws it
  /// through the model.
  @State private var expired = 0

  var body: some View {
    GeometryReader { geometry in
      let metrics = ReadoutMetrics(
        width: geometry.size.width,
        height: geometry.size.height,
        unitWidth88: ReadoutFont.unitWidth(ReadoutMetrics.reference)
      )
      // Read here so that an expiry, not only a reading, redraws the numbers.
      let _ = expired
      let now = model.now
      ZStack(alignment: .top) {
        VStack(spacing: 0) {
          number(model.pitchText(at: now), size: metrics.pitchSize, metrics: metrics, id: "speedy-pitch")
            .frame(width: geometry.size.width, height: metrics.lineY - metrics.gap, alignment: .bottom)
          Color.clear.frame(height: metrics.gap)
          Rectangle()
            .fill(Color.white.opacity(0.4))
            .frame(height: 2)
            .padding(.horizontal, 16)
          Color.clear.frame(height: metrics.gap)
          number(model.exitText(at: now), size: metrics.exitSize, metrics: metrics, id: "speedy-exit")
            .frame(width: geometry.size.width, alignment: .top)
          Spacer(minLength: 0)
        }
        chrome
        if model.uiTest { testReadouts }
      }
    }
    // Sleeps until each side's dash is due and redraws then, starting again on every reading.
    .task(id: model.board) {
      for expiry in model.board.expiries {
        let wait = expiry.timeIntervalSince(model.now)
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        if Task.isCancelled { return }
        expired += 1
      }
    }
    .background(Color.black.ignoresSafeArea())
    .preferredColorScheme(.dark)
    .statusBarHidden()
    .fullScreenCover(isPresented: $model.showingSettings) {
      SettingsView(model: model)
    }
  }

  private func number(_ text: String, size: Double, metrics: ReadoutMetrics, id: String) -> some View {
    let fitted = metrics.fitted(size: size, textWidthAtSize: ReadoutFont.unitWidth(text) * size)
    return Text(text)
      .font(ReadoutFont.font(size: fitted))
      .foregroundStyle(.white)
      .lineLimit(1)
      .fixedSize()
      .accessibilityIdentifier(id)
  }

  private var chrome: some View {
    VStack {
      HStack {
        Spacer()
        Button { model.openSettings() } label: {
          Image(systemName: "gearshape.fill")
            .font(.system(size: 24))
            .frame(width: 44, height: 44)
        }
        .accessibilityIdentifier("speedy-settings")
        .accessibilityLabel("Settings")
      }
      Spacer()
      ZStack {
        if model.showsPairHint {
          Text("Tap ⚙ to pair a radar")
            .font(.system(size: 17))
            .foregroundStyle(Color.white.opacity(0.6))
            .accessibilityIdentifier("speedy-pair-hint")
        }
        HStack {
          Spacer()
          Button { model.toggleAudio() } label: {
            Image(systemName: model.audioOn ? "speaker.wave.2.fill" : "speaker.slash.fill")
              .font(.system(size: 24))
              .frame(width: 44, height: 44)
          }
          .accessibilityIdentifier(model.audioOn ? "speedy-audio-on" : "speedy-audio-off")
          .accessibilityLabel(model.audioOn ? "Audio on" : "Audio off")
        }
      }
    }
    .foregroundStyle(Color.white.opacity(0.7))
    .padding(.horizontal, 12)
  }

  /// Black on black: invisible from the stands, readable by a UI test.
  private var testReadouts: some View {
    VStack(alignment: .leading) {
      Text(model.speechLog.isEmpty ? "-" : model.speechLog)
        .accessibilityIdentifier("speedy-speech-log")
      Text(UIApplication.shared.isIdleTimerDisabled ? "idle-timer-off" : "idle-timer-on")
        .accessibilityIdentifier("speedy-awake")
    }
    .font(.system(size: 10))
    .foregroundStyle(Color.black)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.leading, 4)
  }
}

/// The readout's typeface: the heavy rounded system font with digits all one width.
enum ReadoutFont {
  static func font(size: Double) -> Font {
    .system(size: size, weight: .heavy, design: .rounded).monospacedDigit()
  }

  /// Widths already measured: the readout asks for the same few strings every second.
  @MainActor private static var widths: [String: Double] = [:]

  /// How wide `text` draws at size 1.
  @MainActor static func unitWidth(_ text: String) -> Double {
    if let known = widths[text] { return known }
    let width = measure(text)
    widths[text] = width
    return width
  }

  private static func measure(_ text: String) -> Double {
    let base = UIFont.systemFont(ofSize: 100, weight: .heavy)
    let rounded = base.fontDescriptor.withDesign(.rounded) ?? base.fontDescriptor
    let monospaced = rounded.addingAttributes([
      .featureSettings: [ [
        UIFontDescriptor.FeatureKey.type: kNumberSpacingType,
        UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector
      ] ]
    ])
    let font = UIFont(descriptor: monospaced, size: 100)
    return (text as NSString).size(withAttributes: [ .font: font ]).width / 100
  }
}
