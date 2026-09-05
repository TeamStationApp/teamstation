import Foundation

/// How many columns the Settings sheet lays its five cards out in.
///
/// Cameraman is landscape-only on a phone and has always used two columns. GS Preview rotates, and
/// a phone in portrait cannot fit two cards side by side, so it stacks them. Pure, so the rule is
/// unit-tested for the sizes that matter rather than eyeballed on each device.
public enum SettingsLayout {
  /// Below this width a landscape window still stacks (a narrow split view, or a small phone).
  public static let twoColumnMinimumWidth: Double = 600

  public static func columns(for size: CGSize) -> Int {
    size.width > size.height && size.width >= twoColumnMinimumWidth ? 2 : 1
  }
}
