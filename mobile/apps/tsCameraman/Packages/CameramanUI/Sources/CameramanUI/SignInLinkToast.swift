import SwiftUI

/// What a sign-in link did, over the camera screen: signed in, or whose link it was.
struct SignInLinkToast: View {
  let message: String?

  var body: some View {
    if let message {
      Text(message)
        .font(.callout)
        .multilineTextAlignment(.center)
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.25)))
        .frame(maxWidth: 520)
        // Below the camera screen's top bar, so the name, settings and thermal state stay readable.
        .padding(.top, 72)
        .padding(.horizontal, 24)
        .accessibilityIdentifier("sign-in-link-message")
        .transition(.opacity)
        .animation(.easeInOut, value: message)
    }
  }
}
