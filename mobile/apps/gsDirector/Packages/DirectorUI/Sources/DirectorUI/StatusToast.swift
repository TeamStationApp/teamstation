import SwiftUI

/// Operator-facing warnings that used to live in the toolbar, where a long replay error was clipped
/// to one line. Rises from the bottom of whichever screen is showing and stays until dismissed.
struct StatusToast: View {
  @Environment(AppEnvironment.self) private var environment

  var body: some View {
    Group {
      if let message = environment.statusMessage {
        HStack(alignment: .top, spacing: 12) {
          VStack(alignment: .leading, spacing: 4) {
            Text(message)
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(.black)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("status-message")
            // When it happened, in local time to the millisecond. A warning read ten minutes
            // later is a different problem from one read at once, and the toast stays up until
            // dismissed, so the words alone cannot say which.
            if let postedAt = environment.statusMessagePostedAt {
              Text(StatusTimestamp.format(postedAt))
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.black.opacity(0.6))
                .accessibilityIdentifier("status-timestamp")
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)

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
        // The whole card dismisses, not only the X: a warning during a game is read and swiped
        // away with whichever thumb is free, and a 44-point target is not what that thumb finds.
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onTapGesture {
          environment.dismissStatusMessage()
        }
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
