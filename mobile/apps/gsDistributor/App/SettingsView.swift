import AppKit
import DistributorWire
import SwiftUI

/// GS Distributor's settings. They are GS Director's to keep: every change is saved on the iPad,
/// and with no iPad connected there is nothing to show.
struct SettingsView: View {
  let model: DistributorModel

  @State private var hostDraft = ""
  @State private var hostProblem: String?

  var body: some View {
    Group {
      if let settings = model.settings {
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

          Section("Combined video") {
            Toggle("Create a combined video", isOn: createsCombined)
              .accessibilityIdentifier("settings-create-combined")
          }

          Section("PeerTube") {
            Toggle("Upload to PeerTube", isOn: uploadsToPeerTube)
              .accessibilityIdentifier("settings-peertube")
            if settings.peerTube.enabled {
              TextField("Instance", text: $hostDraft, prompt: Text("videos.example.org"))
                .onSubmit { commitHost() }
                .accessibilityIdentifier("settings-peertube-host")
              if let hostProblem {
                Text(hostProblem)
                  .font(.caption)
                  .foregroundStyle(.red)
              }
            }
          }
        }
        .formStyle(.grouped)
        .onAppear { hostDraft = settings.peerTube.host ?? "" }
      } else {
        ContentUnavailableView(
          "Connect GS Director",
          systemImage: "cable.connector",
          description: Text("GS Distributor's settings are kept on the iPad.")
        )
      }
    }
    .frame(width: 520, height: 360)
  }

  // MARK: - Bindings

  private var createsCombined: Binding<Bool> {
    Binding(
      get: { model.settings?.createCombined ?? false },
      set: { isOn in Task { await model.updateSettings { $0.createCombined = isOn } } }
    )
  }

  private var uploadsToPeerTube: Binding<Bool> {
    Binding(
      get: { model.settings?.peerTube.enabled ?? false },
      set: { isOn in Task { await model.updateSettings { $0.peerTube.enabled = isOn } } }
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
  private func commitHost() {
    do {
      let host = try PeerTubeHost.normalize(hostDraft)
      hostDraft = host
      hostProblem = nil
      Task { await model.updateSettings { $0.peerTube.host = host } }
    } catch {
      switch error {
      case .insecure: hostProblem = "PeerTube must be reached over HTTPS"
      case .empty: hostProblem = "Type the instance's host name, like videos.example.org"
      case .notAHost: hostProblem = "That is not a host name"
      }
    }
  }
}
