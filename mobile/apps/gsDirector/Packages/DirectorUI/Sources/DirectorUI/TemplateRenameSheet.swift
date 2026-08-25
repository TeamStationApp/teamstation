import SwiftUI

/// Pencil-opened rename sheet used by Content and Remote editors. Alerts cannot host a clear X.
struct TemplateRenameSheet: View {
  let title: String
  @Binding var name: String
  let fieldIdentifier: String
  let clearIdentifier: String
  let onCancel: () -> Void
  let onSave: () -> Void

  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      Form {
        Section {
          HStack {
            TextField("Name", text: $name)
              .focused($focused)
              .accessibilityIdentifier(fieldIdentifier)
            if !name.isEmpty {
              Button {
                name = ""
              } label: {
                Image(systemName: "xmark.circle.fill")
                  .foregroundStyle(.secondary)
              }
              .buttonStyle(.borderless)
              .accessibilityIdentifier(clearIdentifier)
              .accessibilityLabel("Clear name")
            }
          }
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save", action: onSave)
            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .onAppear { focused = true }
    .presentationDetents([.medium, .large])
  }
}
