import DirectorCore
import DirectorPipeline
import SwiftUI

/// Oscilloscope of one camera's native PCM. Gain is applied in the view so the sweep jumps as
/// soon as the operator moves the slider, without waiting for the next audio packet.
struct SourceWaveformCanvas: View {
  var snapshot: AudioWaveformMonitor.Snapshot
  var gain: Double

  var body: some View {
    Canvas { context, size in
      let multiplier = SourceSelectionRules.mixMultiplier(forGain: gain)
      let midY = size.height / 2
      let amp = max(1, size.height / 2 - 1)
      let samples = snapshot.samples
      let last = max(samples.count - 1, 1)

      for index in 1 ..< samples.count {
        let x0 = CGFloat(index - 1) / CGFloat(last) * size.width
        let x1 = CGFloat(index) / CGFloat(last) * size.width
        let s0 = Double(samples[index - 1]) * multiplier
        let s1 = Double(samples[index]) * multiplier
        let clipped = abs(s0) >= 0.99 || abs(s1) >= 0.99
        var segment = Path()
        segment.move(to: CGPoint(x: x0, y: Self.y(s0, midY: midY, amp: amp)))
        segment.addLine(to: CGPoint(x: x1, y: Self.y(s1, midY: midY, amp: amp)))
        context.stroke(
          segment,
          with: .color(clipped ? Color.recordRed : Color.programGreen),
          lineWidth: 1
        )
      }

      let barY = size.height * (1 - SourceSelectionRules.clampedInputGain(gain))
      var bar = Path()
      bar.move(to: CGPoint(x: 0, y: barY))
      bar.addLine(to: CGPoint(x: size.width, y: barY))
      context.stroke(bar, with: .color(Color.sourceBlue), lineWidth: 2)
    }
  }

  private static func y(_ sample: Double, midY: CGFloat, amp: CGFloat) -> CGFloat {
    midY - CGFloat(max(-1, min(1, sample))) * amp
  }
}

struct SourceWaveformThumb: View {
  let index: Int
  let sourceID: SourceID
  let gain: Double
  let monitor: AudioWaveformMonitor
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      TimelineView(.periodic(from: .now, by: 1.0 / 30.0)) { _ in
        SourceWaveformCanvas(snapshot: monitor.snapshot(for: sourceID), gain: gain)
      }
      .frame(width: 88, height: 36)
      .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 4))
      .overlay {
        RoundedRectangle(cornerRadius: 4)
          .strokeBorder(Color.sourceBlue, lineWidth: 1.5)
      }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("source-waveform-\(index + 1)")
    .accessibilityLabel("Input waveform")
    .accessibilityValue("gain=\(Self.percent(gain))")
    .accessibilityAddTraits(.isButton)
  }

  static func percent(_ gain: Double) -> Int {
    Int((SourceSelectionRules.clampedInputGain(gain) * 100).rounded())
  }
}

struct SourceWaveformDetailView: View {
  let selection: SourceSelection
  let monitor: AudioWaveformMonitor
  let onClose: () -> Void
  let onGain: (Double) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        Text(selection.displayName)
          .font(.system(size: 18, weight: .semibold, design: .rounded))
          .foregroundStyle(.white)
        Spacer()
        Text("\(SourceWaveformThumb.percent(selection.inputGain))%")
          .font(.system(size: 22, weight: .heavy, design: .rounded))
          .foregroundStyle(.white)
          .accessibilityIdentifier("source-gain-value")
          .accessibilityValue("gain=\(SourceWaveformThumb.percent(selection.inputGain))")
        Button(action: onClose) {
          Text("CLOSE")
            .font(.system(size: 12, weight: .heavy, design: .rounded))
            .tracking(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("source-waveform-close")
      }

      HStack(alignment: .center, spacing: 18) {
        TimelineView(.periodic(from: .now, by: 1.0 / 30.0)) { _ in
          SourceWaveformCanvas(
            snapshot: monitor.snapshot(for: selection.id),
            gain: selection.inputGain
          )
        }
        .frame(minHeight: 180)
        .background(Color.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
          RoundedRectangle(cornerRadius: 8)
            .strokeBorder(Color.sourceBlue, lineWidth: 1.5)
        }

        VerticalGainSlider(gain: selection.inputGain, onChange: onGain)
          .frame(width: 44, height: 180)
      }
    }
    .padding(20)
    .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("source-waveform-detail")
    .accessibilityValue("gain=\(SourceWaveformThumb.percent(selection.inputGain))")
  }
}

struct VerticalGainSlider: View {
  var gain: Double
  var onChange: (Double) -> Void

  var body: some View {
    GeometryReader { geo in
      let clamped = SourceSelectionRules.clampedInputGain(gain)
      let y = (1 - clamped) * geo.size.height
      ZStack(alignment: .top) {
        Capsule()
          .fill(Color.white.opacity(0.14))
          .frame(width: 8)
          .frame(maxHeight: .infinity)

        VStack(spacing: 0) {
          Spacer(minLength: 0)
          Capsule()
            .fill(Color.sourceBlue)
            .frame(width: 8, height: max(8, clamped * geo.size.height))
        }

        Circle()
          .fill(Color.white)
          .frame(width: 22, height: 22)
          .position(x: geo.size.width / 2, y: min(geo.size.height, max(0, y)))
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { value in
            let next = 1 - Double(value.location.y / geo.size.height)
            onChange(SourceSelectionRules.clampedInputGain(next))
          }
      )
    }
    .accessibilityIdentifier("source-gain-slider")
    .accessibilityLabel("Input volume")
    .accessibilityValue("gain=\(SourceWaveformThumb.percent(gain))")
    .accessibilityAdjustableAction { direction in
      let step = 0.05
      switch direction {
      case .increment: onChange(SourceSelectionRules.clampedInputGain(gain + step))
      case .decrement: onChange(SourceSelectionRules.clampedInputGain(gain - step))
      default: break
      }
    }
  }
}
