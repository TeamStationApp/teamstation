import SwiftUI

/// Compact name editor shown as a centered hover. Full-screen chrome is reserved for forms with more than a field.
struct TemplateRenameSheet: View {
  let title: String
  @Binding var name: String
  let fieldIdentifier: String
  let clearIdentifier: String
  let onCancel: () -> Void
  let onSave: () -> Void

  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(title)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.white)
      HStack {
        TextField("Name", text: $name)
          .focused($focused)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .accessibilityIdentifier(fieldIdentifier)
        if !name.isEmpty {
          Button {
            name = ""
          } label: {
            Image(systemName: "xmark.circle.fill")
              .symbolRenderingMode(.hierarchical)
              .foregroundStyle(Color.white.opacity(0.55), Color.white.opacity(0.22))
          }
          .buttonStyle(.borderless)
          .tint(Color.white.opacity(0.55))
          .accessibilityIdentifier(clearIdentifier)
          .accessibilityLabel("Clear name")
        }
      }
      .padding(10)
      .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
      ModalActionFooter(
        cancelTitle: "CANCEL",
        cancelIdentifier: "template-rename-cancel",
        onCancel: onCancel,
        primaryTitle: "SAVE",
        primaryIdentifier: "template-rename-save",
        primaryEnabled: !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        action: onSave
      )
    }
    .padding(20)
    .frame(maxWidth: 420)
    .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 16))
    .onAppear { focused = true }
  }
}

/// Dimmed scrim plus a centered card. Used for name-only editors.
struct CenteredHover<Content: View>: View {
  var onCancel: () -> Void
  @ViewBuilder var content: () -> Content

  var body: some View {
    ZStack {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture(perform: onCancel)
      content()
        .padding(28)
    }
  }
}
