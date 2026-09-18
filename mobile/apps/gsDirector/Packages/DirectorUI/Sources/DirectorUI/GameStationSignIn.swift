import GameStationKit
import SwiftUI

/// Signing this Director in to a GameStation account.
///
/// An address, and then whichever answer arrives first: the six-digit code
/// typed here, or the button in the same e-mail tapped on **anything** — a
/// phone, a laptop, the iPad itself. GameStation approves the request whichever
/// door it comes through, and this screen, holding a secret nobody else has,
/// asks every couple of seconds whether that has happened and signs itself in
/// when it has.
///
/// That is why there is no browser sheet here and no link that has to open this
/// app. A parent standing at a field with the iPad can be signed in by somebody
/// at home tapping a button in their own mail.
struct GameStationSignIn: View {
  @Environment(AppEnvironment.self) private var environment
  /// The way out, for the same reason the event picker needs one.
  let onClose: () -> Void
  @State private var email = ""
  @State private var code = ""
  @State private var busy = false
  @State private var message: String?

  /// How often the iPad asks whether somebody has answered the e-mail.
  private let poll = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

  var body: some View {
    let account = environment.gameStation
    VStack(spacing: 0) {
      HStack {
        Text("GameStation account")
          .font(.title3.weight(.semibold))
        Spacer()
        Button("Done") { onClose() }
          .accessibilityIdentifier("gamestation-sign-in-done")
      }
      .padding()
      form(account)
    }
  }

  @ViewBuilder
  private func form(_ account: GameStationAccount) -> some View {
    Form {
      if let user = account.user {
        Section {
          LabeledContent("Signed in as", value: user.displayName)
          if let address = user.email {
            LabeledContent("E-mail", value: address)
          }
          Button("Sign out", role: .destructive) {
            account.signOut()
          }
          .accessibilityIdentifier("gamestation-sign-out")
        } header: {
          Text("GameStation")
        } footer: {
          Text(
            "Signed in, this Director lists the games your teams are playing and streams to one without a URL being typed."
          )
        }
      } else if account.waiting != nil {
        Section {
          Text("Waiting for the e-mail sent to \(email)")
            .foregroundStyle(.secondary)
          TextField("123456", text: $code)
            .keyboardType(.numberPad)
            .accessibilityIdentifier("gamestation-code")
          Button("Sign in with the code") {
            signIn()
          }
          .disabled(busy || code.trimmingCharacters(in: .whitespaces).count < 4)
          .accessibilityIdentifier("gamestation-submit-code")
          Button("Use a different address") {
            account.signOut()
            code = ""
            message = nil
          }
        } header: {
          Text("Check your e-mail")
        } footer: {
          Text(
            "Tap the button in the e-mail — on this iPad or any other device — and this screen will sign itself in. Or type the code."
          )
        }
      } else {
        Section {
          TextField("parent@example.com", text: $email)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("gamestation-email")
          Button("Send me a sign-in e-mail") {
            start()
          }
          .disabled(busy || !email.contains("@"))
          .accessibilityIdentifier("gamestation-send-code")
        } header: {
          Text("Sign in to GameStation")
        } footer: {
          Text(
            "GameStation sends a button and a six-digit code. Either one signs this iPad in."
          )
        }
      }

      if let message {
        Section {
          Text(message).foregroundStyle(.secondary)
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(Color.black)
    .onReceive(poll) { _ in
      guard account.user == nil, account.waiting != nil else { return }
      Task { await account.pollSignIn() }
    }
  }

  private func start() {
    busy = true
    message = nil
    Task {
      do {
        try await environment.gameStation.startSignIn(
          email: email.trimmingCharacters(in: .whitespaces).lowercased()
        )
        message = "Sent. The button and the code both last ten minutes."
      } catch {
        message = error.localizedDescription
      }
      busy = false
    }
  }

  private func signIn() {
    busy = true
    message = nil
    Task {
      do {
        try await environment.gameStation.completeSignIn(
          email: email.trimmingCharacters(in: .whitespaces).lowercased(),
          code: code.trimmingCharacters(in: .whitespaces)
        )
        message = nil
      } catch {
        message = error.localizedDescription
      }
      busy = false
    }
  }
}
