import SwiftUI

/// Green primary action used by the camera list DONE button and every other modal footer.
struct ModalPrimaryButton: View {
  let title: String
  let identifier: String
  var enabled: Bool = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 13, weight: .heavy, design: .rounded))
        .tracking(1)
        .padding(.horizontal, 20)
        .padding(.vertical, 11)
        .background(
          enabled ? Color.programGreen : Color.white.opacity(0.12),
          in: RoundedRectangle(cornerRadius: 8)
        )
        .foregroundStyle(enabled ? Color.black : Color.white.opacity(0.35))
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityIdentifier(identifier)
  }
}

/// Unfilled cancel next to a green Save / Create / Done.
struct ModalCancelButton: View {
  let title: String
  let identifier: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 13, weight: .heavy, design: .rounded))
        .tracking(1)
        .padding(.horizontal, 20)
        .padding(.vertical, 11)
        .foregroundStyle(.white)
        .overlay(
          RoundedRectangle(cornerRadius: 8)
            .strokeBorder(Color.white.opacity(0.45), lineWidth: 1)
        )
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
  }
}

/// Sticky bar at the bottom of a full-size modal. Primary action sits on the right, matching cameras.
struct ModalActionFooter: View {
  var cancelTitle: String?
  var cancelIdentifier: String?
  var onCancel: (() -> Void)?
  var primaryTitle: String
  var primaryIdentifier: String
  var primaryEnabled: Bool = true
  var action: () -> Void

  var body: some View {
    HStack(spacing: 16) {
      Spacer()
      if let cancelTitle, let cancelIdentifier, let onCancel {
        ModalCancelButton(title: cancelTitle, identifier: cancelIdentifier, action: onCancel)
      }
      ModalPrimaryButton(
        title: primaryTitle,
        identifier: primaryIdentifier,
        enabled: primaryEnabled,
        action: action
      )
    }
    .padding(24)
    .background(Color.deckBackground)
  }
}
