import AppKit
import DistributorWire
import SwiftUI

/// TS Distributor's settings. This Mac keeps them and so does the iPad: a change made with the
/// iPad away reaches it when it is next attached.
struct SettingsView: View {
  let model: DistributorModel

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
        Text("This Mac stitches every file. Files the iPad has already stitched are still fetched from it rather than made again.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section("Combined video") {
        Toggle("Create a combined video", isOn: createsCombined)
          .accessibilityIdentifier("settings-create-combined")
      }

      Section("TeamStation") {
        TeamStationSection(model: model)
      }
    }
    .formStyle(.grouped)
    .frame(width: 560, height: 680)
  }

  // MARK: - Bindings

  private var createsCombined: Binding<Bool> {
    Binding(
      get: { model.settings.createCombined },
      set: { isOn in Task { await model.updateSettings { $0.createCombined = isOn } } }
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
    panel.message = "Where TS Distributor saves this Mac's downloads"
    panel.directoryURL = model.destination
    guard panel.runModal() == .OK, let url = panel.url else { return }
    let macID = model.macID
    Task { await model.updateSettings { $0.destinations[macID] = url.path } }
  }
}
