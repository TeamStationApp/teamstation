import CameramanCore
import SwiftUI

/// Vertical zoom column: widest at the bottom, tightest at the top, horizontal ticks between pills.
///
/// Spacing is derived from the available height so the stack always fits. Adjacent pill centers are
/// reported so a full-screen drag can use the same points-per-segment as the drawn scale.
struct ZoomScaleView: View {
  let mapping: ZoomMapping
  let displayedZoom: Double
  let onSelect: (Double) -> Void
  let onSegmentLength: (CGFloat) -> Void

  var body: some View {
    let presets = mapping.presetDisplayedZooms
    let highlight = mapping.scaleHighlight(forDisplayed: displayedZoom)

    VStack(spacing: 8) {
      GeometryReader { geo in
        let layout = Layout(height: geo.size.height, presetCount: presets.count)
        VStack(spacing: 0) {
          ForEach(Array(presets.enumerated().reversed()), id: \.offset) { index, preset in
            presetButton(preset, highlight: highlight)
              .background {
                GeometryReader { buttonGeo in
                  Color.clear.preference(
                    key: PillCenterKey.self,
                    value: [index: buttonGeo.frame(in: .named("zoom-column")).midY]
                  )
                }
              }
            if index > 0 {
              tickStack(segment: index - 1, highlight: highlight, spacing: layout.spacing)
            }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .coordinateSpace(name: "zoom-column")
        .onPreferenceChange(PillCenterKey.self) { centers in
          let length = Self.segmentLength(from: centers)
          guard length > 0 else { return }
          DispatchQueue.main.async { onSegmentLength(length) }
        }
      }

      Text(ZoomMapping.label(forDisplayed: displayedZoom))
        .font(.system(.subheadline, design: .monospaced).weight(.semibold))
        .foregroundStyle(.white)
        .accessibilityIdentifier("zoom-label")
    }
    .frame(width: 46)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("zoom-scale")
    .accessibilityValue(accessibilityValue(highlight))
  }

  private func presetButton(_ preset: Double, highlight: ZoomMapping.ScaleHighlight) -> some View {
    let isActive = highlight == .preset(preset)
    return Button {
      onSelect(preset)
    } label: {
      Text(ZoomMapping.label(forDisplayed: preset))
        .font(.system(.subheadline, design: .rounded).weight(.semibold))
        .frame(width: 46, height: 46)
        .background(isActive ? .white.opacity(0.9) : .black.opacity(0.45), in: .circle)
        .foregroundStyle(isActive ? .black : .white)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("zoom-preset-\(ZoomMapping.label(forDisplayed: preset))")
    .accessibilityAddTraits(isActive ? .isSelected : [])
  }

  private func tickStack(segment: Int, highlight: ZoomMapping.ScaleHighlight, spacing: CGFloat) -> some View {
    VStack(spacing: spacing) {
      ForEach((0..<ZoomMapping.scaleTicksPerSegment).reversed(), id: \.self) { tickIndex in
        tick(segment: segment, index: tickIndex, highlight: highlight)
      }
    }
    .padding(.vertical, spacing)
  }

  private func tick(segment: Int, index: Int, highlight: ZoomMapping.ScaleHighlight) -> some View {
    let isActive = highlight == .tick(segment: segment, index: index)
    return Capsule()
      .fill(isActive ? Color.white : Color.white.opacity(0.38))
      .frame(width: isActive ? 22 : 16, height: 3)
      .accessibilityIdentifier("zoom-tick-\(segment)-\(index)")
      .accessibilityAddTraits(isActive ? .isSelected : [])
  }

  private func accessibilityValue(_ highlight: ZoomMapping.ScaleHighlight) -> String {
    switch highlight {
    case let .preset(value):
      return ZoomMapping.label(forDisplayed: value)
    case let .tick(segment, index):
      return "tick \(segment).\(index)"
    }
  }

  private static func segmentLength(from centers: [Int: CGFloat]) -> CGFloat {
    let ordered = centers.keys.sorted().compactMap { centers[$0] }
    guard ordered.count >= 2 else { return 0 }
    var total: CGFloat = 0
    for index in 1..<ordered.count {
      total += abs(ordered[index] - ordered[index - 1])
    }
    return total / CGFloat(ordered.count - 1)
  }

  /// Fits n pills and the ticks between them into `height`. Spacing matches the old 10pt gap when
  /// there is room and shrinks uniformly when there is not.
  fileprivate struct Layout {
    let spacing: CGFloat

    init(height: CGFloat, presetCount: Int) {
      let buttons = max(presetCount, 1)
      let segments = max(buttons - 1, 1)
      let buttonSize: CGFloat = 46
      let tickThickness: CGFloat = 3
      let ticks = CGFloat(ZoomMapping.scaleTicksPerSegment)
      let leftover = height - CGFloat(buttons) * buttonSize - CGFloat(segments) * ticks * tickThickness
      let gaps = CGFloat(segments * (ZoomMapping.scaleTicksPerSegment + 1))
      let raw = gaps > 0 ? leftover / gaps : 10
      spacing = min(10, max(2, raw))
    }
  }
}

private struct PillCenterKey: PreferenceKey {
  static var defaultValue: [Int: CGFloat] { [:] }
  static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
    value.merge(nextValue(), uniquingKeysWith: { _, new in new })
  }
}
