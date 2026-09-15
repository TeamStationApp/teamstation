import SwiftUI

/// Two points on one track, for a range something may move within: a stream's low and high bitrate,
/// a camera's adaptive floor and ceiling.
///
/// SwiftUI has no two-thumb slider. This one keeps the two values apart by construction — the low
/// point never passes the high one — while letting them meet, which is a fixed value. A bar in `tint`
/// fills the track between the points to show the range. Each point is its own adjustable VoiceOver
/// element with its own accessibility identifier, so UI tests can drive either one.
public struct RangeSlider: View {
  @Binding private var lower: Double
  @Binding private var upper: Double
  private let bounds: ClosedRange<Double>
  private let step: Double
  private let tint: Color
  private let lowerIdentifier: String
  private let upperIdentifier: String
  private let valueLabel: (Double) -> String

  /// Which point the current drag moves, chosen when it starts.
  @State private var active: RangeSliderGeometry.Thumb?

  private static let thumbSize: CGFloat = 28
  private static let touchSize: CGFloat = 44

  public init(
    lower: Binding<Double>,
    upper: Binding<Double>,
    in bounds: ClosedRange<Double>,
    step: Double,
    tint: Color = .green,
    lowerIdentifier: String,
    upperIdentifier: String,
    valueLabel: @escaping (Double) -> String
  ) {
    _lower = lower
    _upper = upper
    self.bounds = bounds
    self.step = step
    self.tint = tint
    self.lowerIdentifier = lowerIdentifier
    self.upperIdentifier = upperIdentifier
    self.valueLabel = valueLabel
  }

  public var body: some View {
    GeometryReader { geometry in
      let layout = RangeSliderGeometry(
        bounds: bounds,
        step: step,
        width: Double(max(1, geometry.size.width - Self.thumbSize))
      )
      let lowerX = CGFloat(layout.position(of: lower))
      let upperX = CGFloat(layout.position(of: upper))
      ZStack(alignment: .leading) {
        Capsule()
          .fill(Color.secondary.opacity(0.25))
          .frame(height: 4)
          .padding(.horizontal, Self.thumbSize / 2)
        Capsule()
          .fill(tint)
          .frame(width: max(0, upperX - lowerX), height: 4)
          .offset(x: lowerX + Self.thumbSize / 2)
        thumb(.lower, value: lower, x: lowerX, identifier: lowerIdentifier)
        thumb(.upper, value: upper, x: upperX, identifier: upperIdentifier)
      }
      .frame(maxHeight: .infinity)
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { drag in
            let x = Double(drag.location.x - Self.thumbSize / 2)
            if active == nil {
              active = layout.thumb(
                nearest: Double(drag.startLocation.x - Self.thumbSize / 2),
                lower: lower,
                upper: upper,
                movement: Double(drag.translation.width)
              )
            }
            guard let active else { return }
            let value = layout.value(at: x)
            switch active {
            case .lower: lower = min(value, upper)
            case .upper: upper = max(value, lower)
            }
          }
          .onEnded { _ in active = nil }
      )
    }
    .frame(height: Self.touchSize)
    .accessibilityElement(children: .contain)
  }

  private func thumb(_ which: RangeSliderGeometry.Thumb, value: Double, x: CGFloat, identifier: String) -> some View {
    Circle()
      .fill(.white)
      .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
      .frame(width: Self.thumbSize, height: Self.thumbSize)
      .frame(width: Self.touchSize, height: Self.touchSize)
      .offset(x: x - (Self.touchSize - Self.thumbSize) / 2)
      .accessibilityElement()
      .accessibilityLabel(which == .lower ? "Low" : "High")
      .accessibilityValue(valueLabel(value))
      .accessibilityAdjustableAction { direction in
        let delta = direction == .increment ? step : -step
        switch which {
        case .lower: lower = min(upper, max(bounds.lowerBound, lower + delta))
        case .upper: upper = max(lower, min(bounds.upperBound, upper + delta))
        }
      }
      .accessibilityIdentifier(identifier)
  }
}

/// The arithmetic behind `RangeSlider`, apart from the view so it can be tested.
public struct RangeSliderGeometry: Sendable, Equatable {
  public enum Thumb: Sendable, Equatable {
    case lower
    case upper
  }

  public let bounds: ClosedRange<Double>
  public let step: Double
  /// The distance the thumbs' centres can travel, in points.
  public let width: Double

  public init(bounds: ClosedRange<Double>, step: Double, width: Double) {
    self.bounds = bounds
    self.step = step
    self.width = width
  }

  /// Where on the track `value` sits, from 0 to `width`.
  public func position(of value: Double) -> Double {
    let span = bounds.upperBound - bounds.lowerBound
    guard span > 0 else { return 0 }
    let clamped = min(max(value, bounds.lowerBound), bounds.upperBound)
    return (clamped - bounds.lowerBound) / span * width
  }

  /// The value at a point on the track, snapped to `step` and kept inside `bounds`.
  public func value(at position: Double) -> Double {
    let span = bounds.upperBound - bounds.lowerBound
    let fraction = width > 0 ? min(max(position / width, 0), 1) : 0
    let raw = bounds.lowerBound + fraction * span
    guard step > 0 else { return raw }
    let snapped = bounds.lowerBound + ((raw - bounds.lowerBound) / step).rounded() * step
    return min(max(snapped, bounds.lowerBound), bounds.upperBound)
  }

  /// Which thumb a drag starting at `start` moves: the nearer one, and when they sit on top of each
  /// other, the one the drag heads towards — left for the low point, right for the high one. Nil
  /// while that is still undecided, so the drag waits for its first sideways movement.
  public func thumb(nearest start: Double, lower: Double, upper: Double, movement: Double) -> Thumb? {
    let toLower = abs(start - position(of: lower))
    let toUpper = abs(start - position(of: upper))
    if abs(toLower - toUpper) > 1 { return toLower < toUpper ? .lower : .upper }
    if movement < 0 { return .lower }
    if movement > 0 { return .upper }
    return nil
  }
}
