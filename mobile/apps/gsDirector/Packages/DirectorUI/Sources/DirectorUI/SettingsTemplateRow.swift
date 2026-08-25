import SwiftUI

/// Settings row shared by Content Templates and Remote Control.
struct SettingsTemplateRow: View {
  let name: String
  let isSelected: Bool
  let selectIdentifier: String
  let nameIdentifier: String
  let deleteIdentifier: String
  let onSelect: () -> Void
  let onEdit: () -> Void
  let onDelete: () -> Void

  var body: some View {
    HStack {
      Button(action: onSelect) {
        Image(systemName: isSelected ? "circle.inset.filled" : "circle")
      }
      .buttonStyle(.borderless)
      .padding(.trailing, 12)
      .accessibilityLabel("Select \(name)")
      .accessibilityIdentifier(selectIdentifier)
      .accessibilityValue(isSelected ? "selected" : "unselected")

      Button(action: onEdit) {
        Text(name)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.borderless)
      .accessibilityIdentifier(nameIdentifier)

      Button(role: .destructive, action: onDelete) {
        Image(systemName: "trash")
      }
      .buttonStyle(.borderless)
      .accessibilityIdentifier(deleteIdentifier)
    }
  }
}
