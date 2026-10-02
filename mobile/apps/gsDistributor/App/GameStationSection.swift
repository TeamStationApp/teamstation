import AppKit
import TeamStationKit
import SwiftUI

/// Signing this Mac in to GameStation.
///
/// The same three steps GS Director takes, because it is the same code: ask
/// for a code, wait while somebody reads their e-mail, and hand it back. What
/// it buys is the list of games this account runs, which is what an upload
/// needs to know where to put a recording.
///
/// The Mac signs in on its own rather than borrowing the iPad's session: a
/// token belongs to a device, and the iPad is often at a field while the Mac
/// is not.
struct GameStationSection: View {
  let model: DistributorModel

  @State private var email = ""
  @State private var code = ""
  @State private var busy = false
  @State private var said: String?

  var body: some View {
    if let user = model.gameStation.user {
      LabeledContent("Signed in") {
        HStack(spacing: 8) {
          Text(user.email ?? user.displayName)
            .foregroundStyle(.secondary)
          Button("Sign out") { model.gameStation.signOut() }
            .accessibilityIdentifier("settings-gamestation-sign-out")
        }
      }
      Text("Exports can be uploaded to a game this account runs.")
        .font(.caption)
        .foregroundStyle(.secondary)
    } else if model.gameStation.waiting != nil {
      // Bordered, labelled, and with a Paste button. Unadorned in a grouped
      // Form, a SwiftUI text field is a line of grey placeholder text that
      // reads as a caption — the code arrives on a phone, and the first
      // person to use this could not find anywhere to put it.
      HStack(spacing: 8) {
        TextField("Code from the e-mail", text: $code)
          .textFieldStyle(.roundedBorder)
          .textContentType(.oneTimeCode)
          .accessibilityIdentifier("settings-gamestation-code")
          .onSubmit { finish() }
        Button("Paste") { pasteCode() }
          .accessibilityIdentifier("settings-gamestation-paste")
        Button("Sign in") { finish() }
          .disabled(code.isEmpty || busy)
          .keyboardShortcut(.defaultAction)
          .accessibilityIdentifier("settings-gamestation-finish")
      }
      Button("Send another code") {
        code = ""
        start()
      }
      .buttonStyle(.link)
      note
    } else {
      HStack(spacing: 8) {
        TextField("E-mail address", text: $email)
          .textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("settings-gamestation-email")
          .onSubmit { start() }
        Button("Send me a code") { start() }
          .disabled(email.isEmpty || busy)
          .keyboardShortcut(.defaultAction)
          .accessibilityIdentifier("settings-gamestation-start")
      }
      note
    }
  }

  @ViewBuilder private var note: some View {
    if let said {
      Text(said)
        .font(.caption)
        .foregroundStyle(.orange)
        .accessibilityIdentifier("settings-gamestation-said")
    } else if let error = model.gameStation.lastError {
      Text(error)
        .font(.caption)
        .foregroundStyle(.orange)
    }
  }

  /// The code, from the clipboard, with whatever came with it taken off: a
  /// code copied out of an e-mail brings a space or a newline about half the
  /// time, and a signed-in-or-not decision is not worth losing to one.
  private func pasteCode() {
    let pasted = NSPasteboard.general.string(forType: .string) ?? ""
    code = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func start() {
    busy = true
    said = nil
    Task {
      do {
        try await model.gameStation.startSignIn(email: email)
        said = "A code is on its way to \(email)."
      } catch {
        said = error.localizedDescription
      }
      busy = false
    }
  }

  private func finish() {
    busy = true
    said = nil
    Task {
      do {
        try await model.gameStation.completeSignIn(email: email, code: code)
        code = ""
      } catch {
        said = error.localizedDescription
      }
      busy = false
    }
  }
}
