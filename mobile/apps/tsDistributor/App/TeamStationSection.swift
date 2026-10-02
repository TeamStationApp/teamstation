import AppKit
import TeamStationKit
import SwiftUI

/// Signing this Mac in to TeamStation.
///
/// The same three steps TS Director takes, because it is the same code: ask
/// for a code, wait while somebody reads their e-mail, and hand it back. What
/// it buys is the list of games this account runs, which is what an upload
/// needs to know where to put a recording.
///
/// The Mac signs in on its own rather than borrowing the iPad's session: a
/// token belongs to a device, and the iPad is often at a field while the Mac
/// is not.
struct TeamStationSection: View {
  let model: DistributorModel

  @State private var email = ""
  @State private var code = ""
  @State private var busy = false
  @State private var said: String?

  var body: some View {
    if let user = model.teamStation.user {
      LabeledContent("Signed in") {
        HStack(spacing: 8) {
          Text(user.email ?? user.displayName)
            .foregroundStyle(.secondary)
          Button("Sign out") { model.teamStation.signOut() }
            .accessibilityIdentifier("settings-teamstation-sign-out")
        }
      }
      Text("Exports can be uploaded to a game this account runs.")
        .font(.caption)
        .foregroundStyle(.secondary)
    } else if model.teamStation.waiting != nil {
      // Bordered, labelled, and with a Paste button. Unadorned in a grouped
      // Form, a SwiftUI text field is a line of grey placeholder text that
      // reads as a caption — the code arrives on a phone, and the first
      // person to use this could not find anywhere to put it.
      HStack(spacing: 8) {
        TextField("Code from the e-mail", text: $code)
          .textFieldStyle(.roundedBorder)
          .textContentType(.oneTimeCode)
          .accessibilityIdentifier("settings-teamstation-code")
          .onSubmit { finish() }
        Button("Paste") { pasteCode() }
          .accessibilityIdentifier("settings-teamstation-paste")
        Button("Sign in") { finish() }
          .disabled(code.isEmpty || busy)
          .keyboardShortcut(.defaultAction)
          .accessibilityIdentifier("settings-teamstation-finish")
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
          .accessibilityIdentifier("settings-teamstation-email")
          .onSubmit { start() }
        Button("Send me a code") { start() }
          .disabled(email.isEmpty || busy)
          .keyboardShortcut(.defaultAction)
          .accessibilityIdentifier("settings-teamstation-start")
      }
      note
    }
  }

  @ViewBuilder private var note: some View {
    if let said {
      Text(said)
        .font(.caption)
        .foregroundStyle(.orange)
        .accessibilityIdentifier("settings-teamstation-said")
    } else if let error = model.teamStation.lastError {
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
        try await model.teamStation.startSignIn(email: email)
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
        try await model.teamStation.completeSignIn(email: email, code: code)
        code = ""
      } catch {
        said = error.localizedDescription
      }
      busy = false
    }
  }
}
