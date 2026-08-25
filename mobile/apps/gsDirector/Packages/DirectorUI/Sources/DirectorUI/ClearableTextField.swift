import SwiftUI

/// Trailing clear X matching nearby label text. Hidden when the value is empty.
struct ClearableTextField<Field: View>: View {
  @Binding var text: String
  var clearIdentifier: String
  var clearLabel: String = "Clear"
  @ViewBuilder var field: () -> Field

  var body: some View {
    HStack {
      field()
      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(Color.white.opacity(0.55), Color.white.opacity(0.22))
        }
        .buttonStyle(.borderless)
        .tint(Color.white.opacity(0.55))
        .accessibilityIdentifier(clearIdentifier)
        .accessibilityLabel(clearLabel)
      }
    }
  }
}
