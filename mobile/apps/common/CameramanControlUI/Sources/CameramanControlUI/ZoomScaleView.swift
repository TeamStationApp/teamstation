import CameramanCore
import SwiftUI

/// Vertical zoom column: widest at the bottom, tightest at the top, horizontal ticks between pills.
///
/// The rail fills the height below the thermal pill. First and last stops sit on that span
/// whether there are two presets or five; ticks stretch to fill the gaps. The live zoom
/// readout sits to the left of the pills. Adjacent pill centers are reported so a full-screen
/// drag can use the same points-per-segment as the drawn scale. Zoom past the camera's own ceiling
/// is Cameraman's software zoom, and its pill, ticks and readout are yellow instead of white.
public struct ZoomScaleView: View {
  let mapping: ZoomMapping
  let displayedZoom: Double
  let onSelect: (Double) -> Void
  let onSegmentLength: (CGFloat) -> Void

  public init(
    mapping: ZoomMapping,
    displayedZoom: Double,
    onSelect: @escaping (Double) -> Void,
    onSegmentLength: @escaping (CGFloat) -> Void = { _ in }
  ) {
    self.mapping = mapping
    self.displayedZoom = displayedZoom
    self.onSelect = onSelect
    self.onSegmentLength = onSegmentLength
  }

  public var body: some View {
    let presets = mapping.presetDisplayedZooms
    let highlight = mapping.scaleHighlight(forDisplayed: displayedZoom)

    HStack(alignment: .center, spacing: Metrics.labelGap) {
      Text(ZoomMapping.label(forDisplayed: displayedZoom))
        .font(.system(.caption2, design: .monospaced).weight(.semibold))
        .foregroundStyle(mapping.isSoftwareZoom(displayed: displayedZoom) ? Metrics.softwareColor : .white)
        .frame(minWidth: 28, alignment: .trailing)
        .accessibilityIdentifier("zoom-label")

      rail(presets: presets, highlight: highlight)
        .frame(width: Metrics.buttonSize)
        .coordinateSpace(name: "zoom-column")
        .onPreferenceChange(PillCenterKey.self) { centers in
          let length = Self.segmentLength(from: centers)
          guard length > 0 else { return }
          DispatchQueue.main.async { onSegmentLength(length) }
        }
    }
    .fixedSize(horizontal: true, vertical: false)
    .frame(maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("zoom-scale")
    .accessibilityValue(accessibilityValue(highlight))
  }

  @ViewBuilder
  private func rail(presets: [Double], highlight: ZoomMapping.ScaleHighlight) -> some View {
    if presets.count <= 1 {
      VStack(spacing: 0) {
        Spacer(minLength: 0)
        if let preset = presets.first {
          presetButton(preset, highlight: highlight, index: 0)
        }
        Spacer(minLength: 0)
      }
    } else {
      VStack(spacing: 0) {
        ForEach(Array(presets.enumerated().reversed()), id: \.offset) { index, preset in
          presetButton(preset, highlight: highlight, index: index)
          if index > 0 {
            tickStack(segment: index - 1, highlight: highlight)
          }
        }
      }
    }
  }

  private func presetButton(
    _ preset: Double,
    highlight: ZoomMapping.ScaleHighlight,
    index: Int
  ) -> some View {
    let isActive = highlight == .preset(preset)
    let color = mapping.isSoftwareZoom(displayed: preset) ? Metrics.softwareColor : .white
    return Button {
      onSelect(preset)
    } label: {
      Text(ZoomMapping.label(forDisplayed: preset))
        .font(.system(.caption2, design: .rounded).weight(.semibold))
        .frame(width: Metrics.buttonSize, height: Metrics.buttonSize)
        .background(isActive ? color.opacity(0.9) : Color.black.opacity(0.45), in: .circle)
        .foregroundStyle(isActive ? .black : color)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("zoom-preset-\(ZoomMapping.label(forDisplayed: preset))")
    .accessibilityAddTraits(isActive ? .isSelected : [])
    .background {
      GeometryReader { buttonGeo in
        Color.clear.preference(
          key: PillCenterKey.self,
          value: [index: buttonGeo.frame(in: .named("zoom-column")).midY]
        )
      }
    }
  }

  /// Ticks share leftover height equally, so two stops and five stops pin first/last to the same
  /// edges of the rail.
  private func tickStack(segment: Int, highlight: ZoomMapping.ScaleHighlight) -> some View {
    VStack(spacing: 0) {
      Spacer(minLength: Metrics.minSpacing)
      ForEach((0..<ZoomMapping.scaleTicksPerSegment).reversed(), id: \.self) { tickIndex in
        tick(segment: segment, index: tickIndex, highlight: highlight)
        Spacer(minLength: Metrics.minSpacing)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func tick(segment: Int, index: Int, highlight: ZoomMapping.ScaleHighlight) -> some View {
    let isActive = highlight == .tick(segment: segment, index: index)
    let color = mapping.isSoftwareSegment(segment) ? Metrics.softwareColor : .white
    return Capsule()
      .fill(isActive ? color : color.opacity(0.38))
      .frame(width: isActive ? 14 : 10, height: Metrics.tickThickness)
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

  private enum Metrics {
    static let buttonSize: CGFloat = 32
    static let tickThickness: CGFloat = 1.5
    static let minSpacing: CGFloat = 1
    static let labelGap: CGFloat = 6
    static let softwareColor = Color.yellow
  }
}

private struct PillCenterKey: PreferenceKey {
  static var defaultValue: [Int: CGFloat] { [:] }
  static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
    value.merge(nextValue(), uniquingKeysWith: { _, new in new })
  }
}
