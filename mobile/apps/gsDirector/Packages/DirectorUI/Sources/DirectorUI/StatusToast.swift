import SwiftUI

/// Operator-facing warnings that used to live in the toolbar, where a long replay error was clipped
/// to one line. Rises from the bottom of whichever screen is showing and stays until dismissed.
struct StatusToast: View {
  @Environment(AppEnvironment.self) private var environment

  var body: some View {
    Group {
      if let message = environment.statusMessage {
        HStack(alignment: .top, spacing: 12) {
          Text(message)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.black)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("status-message")

          Button {
            environment.dismissStatusMessage()
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.system(size: 22, weight: .semibold))
              .foregroundStyle(.black.opacity(0.55))
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("status-dismiss")
          .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.vertical, 12)
        .background(Color.replayAmber, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("status-toast")
      }
    }
    .animation(.spring(duration: 0.38, bounce: 0.18), value: environment.statusMessage)
  }
}
