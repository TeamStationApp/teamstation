import AppKit
import DistributorWire
import SwiftUI

/// GS Distributor's settings. This Mac keeps them and so does the iPad: a change made with the
/// iPad away reaches it when it is next attached.
struct SettingsView: View {
  let model: DistributorModel

  @State private var hostDraft = ""
  @State private var hostProblem: String?
  @State private var usernameDraft = ""
  @State private var password = ""
  @State private var code = ""
  @State private var needsCode = false
  @State private var signingIn = false
  @State private var signInProblem: String?

  var body: some View {
    Form {
      Section("Downloads") {
        LabeledContent("Save to") {
          HStack {
            Text(model.destination?.path ?? "Not chosen")
              .foregroundStyle(destinationExists ? Color.primary : Color.red)
              .lineLimit(1)
              .truncationMode(.middle)
              .accessibilityIdentifier("settings-destination")
            Button("Choose…") { chooseDestination() }
              .accessibilityIdentifier("settings-choose-destination")
          }
        }
      }

      Section("Stitching") {
        Toggle("Enable iPad Stitching", isOn: stitchesOnIPad)
          .accessibilityIdentifier("settings-ipad-stitching")
        Text("Off, this Mac stitches every file. Files the iPad has already stitched are still fetched from it.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section("Combined video") {
        Toggle("Create a combined video", isOn: createsCombined)
          .accessibilityIdentifier("settings-create-combined")
      }

      Section("PeerTube") {
        Toggle("Upload to PeerTube", isOn: uploadsToPeerTube)
          .accessibilityIdentifier("settings-peertube")
        if model.settings.peerTube.enabled {
          peerTubeAccount
        }
      }
    }
    .formStyle(.grouped)
    .onAppear {
      hostDraft = model.settings.peerTube.host ?? ""
      usernameDraft = model.settings.peerTube.username ?? ""
    }
    .frame(width: 520, height: 480)
  }

  // MARK: - PeerTube

  @ViewBuilder private var peerTubeAccount: some View {
    switch model.peerTube {
    case .signedIn(let account):
      LabeledContent("Account") {
        HStack {
          Text("\(account.username) on \(account.host)")
            .accessibilityIdentifier("settings-peertube-account")
          Button("Sign Out") { Task { await model.signOutOfPeerTube() } }
            .accessibilityIdentifier("settings-peertube-signout")
        }
      }
      Text("The channel and privacy are chosen with each upload.")
        .font(.caption)
        .foregroundStyle(.secondary)

    case .unknown:
      ProgressView()
        .controlSize(.small)

    case .unreachable(let reason):
      LabeledContent("Account") {
        HStack {
          Text("PeerTube did not answer: \(reason)")
            .foregroundStyle(.red)
            .lineLimit(2)
          Button("Try Again") { Task { await model.loadPeerTube() } }
        }
      }

    case .signedOut:
      TextField("Instance", text: $hostDraft, prompt: Text("videos.example.org"))
        .onSubmit { commitHost() }
        .accessibilityIdentifier("settings-peertube-host")
      if let hostProblem {
        Text(hostProblem)
          .font(.caption)
          .foregroundStyle(.red)
      }
      TextField("User name", text: $usernameDraft)
        .textContentType(.username)
        .accessibilityIdentifier("settings-peertube-username")
      SecureField("Password", text: $password)
        .textContentType(.password)
        .onSubmit { signIn() }
        .accessibilityIdentifier("settings-peertube-password")
      if needsCode {
        TextField("Two-factor code", text: $code)
          .textContentType(.oneTimeCode)
          .onSubmit { signIn() }
          .accessibilityIdentifier("settings-peertube-code")
      }
      HStack {
        if let signInProblem {
          Text(signInProblem)
            .font(.caption)
            .foregroundStyle(.red)
        }
        Spacer()
        if signingIn { ProgressView().controlSize(.small) }
        Button("Sign In") { signIn() }
          .disabled(signingIn || usernameDraft.isEmpty || password.isEmpty)
          .accessibilityIdentifier("settings-peertube-signin")
      }
      Text("This Mac keeps the login in its Keychain and gives it to the iPad, so either can upload while the other is away.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  // MARK: - Bindings

  private var createsCombined: Binding<Bool> {
    Binding(
      get: { model.settings.createCombined },
      set: { isOn in Task { await model.updateSettings { $0.createCombined = isOn } } }
    )
  }

  private var stitchesOnIPad: Binding<Bool> {
    Binding(
      get: { model.settings.iPadStitching },
      set: { isOn in Task { await model.updateSettings { $0.iPadStitching = isOn } } }
    )
  }

  private var uploadsToPeerTube: Binding<Bool> {
    Binding(
      get: { model.settings.peerTube.enabled },
      set: { isOn in
        Task {
          await model.updateSettings { $0.peerTube.enabled = isOn }
          await model.loadPeerTube()
        }
      }
    )
  }

  // MARK: - Actions

  private var destinationExists: Bool {
    guard let destination = model.destination else { return false }
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: destination.path, isDirectory: &isDirectory)
      && isDirectory.boolValue
  }

  private func chooseDestination() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = "Choose"
    panel.message = "Where GS Distributor saves this Mac's downloads"
    panel.directoryURL = model.destination
    guard panel.runModal() == .OK, let url = panel.url else { return }
    let macID = model.macID
    Task { await model.updateSettings { $0.destinations[macID] = url.path } }
  }

  /// The field takes a host, not a URL: `https://` and anything after the host are dropped, and
  /// plain http is refused.
  @discardableResult
  private func commitHost() -> String? {
    do {
      let host = try PeerTubeHost.normalize(hostDraft)
      hostDraft = host
      hostProblem = nil
      Task { await model.updateSettings { $0.peerTube.host = host } }
      return host
    } catch {
      switch error {
      case .insecure: hostProblem = "PeerTube must be reached over HTTPS"
      case .empty: hostProblem = "Type the instance's host name, like videos.example.org"
      case .notAHost: hostProblem = "That is not a host name"
      }
      return nil
    }
  }

  private func signIn() {
    guard !signingIn, let host = commitHost() else { return }
    let username = usernameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    signingIn = true
    signInProblem = nil
    Task {
      let outcome = await model.signInToPeerTube(
        host: host,
        username: username,
        password: password,
        code: needsCode ? code : nil
      )
      signingIn = false
      switch outcome {
      case .signedIn:
        password = ""
        code = ""
        needsCode = false
      case .needsCode:
        if needsCode { signInProblem = "That code was not accepted." }
        needsCode = true
      case .failed(let reason):
        signInProblem = reason
      }
    }
  }
}
