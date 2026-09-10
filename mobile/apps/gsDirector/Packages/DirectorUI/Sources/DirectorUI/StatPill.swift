import SwiftUI

/// One small chrome number on a tile header: white on the nameplate's translucent grey.
///
/// The source tiles' loss pill and the Output tile's stats sit in the same header row and are
/// meant to read as one set, so they share this rather than each carrying their own copy of the
/// styling. Untappable: a tap on a tile's chrome still cuts that tile to programme.
struct StatPill: View {
  let text: String
  let identifier: String
  var label: String?
  var value: String?

  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .bold, design: .rounded))
      .monospacedDigit()
      .foregroundStyle(.white)
      .fixedSize()
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .background(.black.opacity(0.45), in: Capsule())
      .allowsHitTesting(false)
      .accessibilityElement(children: .ignore)
      .accessibilityIdentifier(identifier)
      .accessibilityLabel(label ?? text)
      .accessibilityValue(value ?? text)
  }
}
