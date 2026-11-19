import Foundation

/// Where TS Speedy's numbers and line go, for a screen of a given size.
///
/// The line sits 15% below the vertical center. The pitch is sized so "88" spans 80% of the width,
/// and the exit is three quarters of that size, so its "88" spans 60%. A number with more digits
/// shrinks to fit 90% of the width rather than run off the screen.
public struct ReadoutMetrics: Equatable, Sendable {
  public static let lineFraction = 0.65
  public static let pitchWidthFraction = 0.80
  public static let exitScale = 0.75
  public static let maxTextWidthFraction = 0.90
  /// The space between the line and each number, as a fraction of the height.
  public static let gapFraction = 0.03
  public static let reference = "88"

  public var lineY: Double
  public var gap: Double
  public var pitchSize: Double
  public var exitSize: Double
  public var maxTextWidth: Double

  /// `unitWidth88` is how wide "88" draws at a font size of 1 in the readout's font.
  public init(width: Double, height: Double, unitWidth88: Double) {
    lineY = height * Self.lineFraction
    gap = height * Self.gapFraction
    pitchSize = Self.pitchSize(unitWidth88: unitWidth88, width: width)
    exitSize = pitchSize * Self.exitScale
    maxTextWidth = width * Self.maxTextWidthFraction
  }

  public static func pitchSize(unitWidth88: Double, width: Double) -> Double {
    guard unitWidth88 > 0 else { return 0 }
    return width * pitchWidthFraction / unitWidth88
  }

  /// The font size that keeps `textWidthAtSize` inside the widest a number may be: `size` itself
  /// when it fits, otherwise scaled down to fit.
  public func fitted(size: Double, textWidthAtSize: Double) -> Double {
    guard textWidthAtSize > maxTextWidth, textWidthAtSize > 0 else { return size }
    return size * maxTextWidth / textWidthAtSize
  }
}
