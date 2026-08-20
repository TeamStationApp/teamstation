import CameramanCapture
import CameramanCore
import SwiftUI
import UIKit

/// Name, codec, format and bitrate. Opening this sheet must not touch the pipeline; only Done
/// applies, and only when something actually changed. A reconfigure that fires because the operator
/// wanted to read the URL would look like the camera glitching.
struct SettingsView: View {
  @Bindable var environment: AppEnvironment
  @Environment(\.dismiss) private var dismiss

  @State private var draftName: String = ""
  @State private var draftSettings: StreamSettings = .default
  @FocusState private var nameFocused: Bool
  @State private var didCopyURL = false

  var body: some View {
    NavigationStack {
      // Two columns because the app is landscape-only: a single form on an 844x390 screen puts
      // everything below the bitrate off the bottom, and a settings sheet whose settings have to be
      // scrolled for is one whose settings do not get found.
      HStack(alignment: .top, spacing: 0) {
        Form {
          serverSection
          nameSection
        }
        Form {
          videoSection
          audioSection
        }
      }
      .navigationTitle("Camera")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { commit() }
            .accessibilityIdentifier("settings-done")
        }
      }
    }
    .onAppear {
      draftName = environment.identity.name
      draftSettings = environment.settings
      didCopyURL = false
    }
  }

  private var nameSection: some View {
    Section {
      HStack(spacing: 10) {
        TextField("Camera name", text: $draftName)
          .textInputAutocapitalization(.words)
          .autocorrectionDisabled()
          .focused($nameFocused)
          .accessibilityIdentifier("settings-name-field")
        Button {
          nameFocused = true
        } label: {
          Image(systemName: "pencil")
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-name-edit")
        .accessibilityLabel("Edit camera name")
      }
      .onChange(of: nameFocused) { _, focused in
        guard focused else { return }
        DispatchQueue.main.async {
          UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil)
        }
      }

      LabeledContent("Identifier", value: environment.identity.cname)
        .font(.system(.footnote, design: .monospaced))
        .accessibilityIdentifier("settings-cname")
    } header: {
      Text("Name")
    } footer: {
      // Worth saying, because the obvious assumption is the opposite: that renaming a camera is
      // what makes it a different camera.
      Text("Renaming does not make this a new camera in GS Producer.")
    }
  }

  private var videoSection: some View {
    Section("Video") {
      Picker("Codec", selection: codecBinding) {
        ForEach(StreamCodec.allCases, id: \.self) { codec in
          Text(codec.displayName).tag(codec)
        }
      }
      .accessibilityIdentifier("settings-codec")

      Picker("Resolution", selection: formatBinding) {
        ForEach(formatOptions, id: \.self) { option in
          Text(option.label).tag(option)
        }
      }
      .accessibilityIdentifier("settings-format")

      VStack(alignment: .leading, spacing: 4) {
        LabeledContent("Bitrate", value: String(format: "%.1f Mbps", bitrateMbps))
          .accessibilityIdentifier("settings-bitrate-value")
        Slider(value: bitrateBinding, in: 1 ... 50, step: 0.5)
          .accessibilityIdentifier("settings-bitrate")
      }

      if let annotation = selectedOption?.annotation {
        Text(annotation)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("settings-format-note")
      }
    }
  }

  private var audioSection: some View {
    Section("Audio") {
      Toggle("Microphone", isOn: $draftSettings.audioEnabled)
        .accessibilityIdentifier("settings-audio")
    }
  }

  private var serverSection: some View {
    Section("Stream") {
      Button(action: copyURL) {
        HStack(alignment: .center, spacing: 10) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Address")
              .foregroundStyle(.secondary)
            Text(environment.streamURL)
              .font(.system(.footnote, design: .monospaced))
              .foregroundStyle(.primary)
              .multilineTextAlignment(.leading)
          }
          Spacer(minLength: 8)
          Image(systemName: didCopyURL ? "checkmark" : "doc.on.doc")
            .foregroundStyle(didCopyURL ? .green : .secondary)
            .accessibilityIdentifier("settings-url-copy")
        }
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("settings-url")
      .accessibilityLabel("Copy stream address")
      .accessibilityValue(environment.streamURL)

      LabeledContent("Clients") {
        Text("\(environment.serverStatus.clientCount)")
          .accessibilityIdentifier("settings-clients")
      }
    }
  }

  // MARK: - Bindings

  /// The catalogue is empty until the camera has been configured, and a picker with no options
  /// cannot show what is currently selected. Falling back to the current settings keeps the row
  /// honest on a simulator and before the first frame.
  private var formatOptions: [FormatCatalogue.Option] {
    let options = environment.formatOptions
    guard options.isEmpty else { return options }
    return [ FormatCatalogue.Option(
      width: draftSettings.width,
      height: draftSettings.height,
      frameRate: draftSettings.frameRate,
      supportsMultiLensSwitching: true
    ) ]
  }

  private var selectedOption: FormatCatalogue.Option? {
    formatOptions.first {
      $0.width == draftSettings.width
        && $0.height == draftSettings.height
        && $0.frameRate == draftSettings.frameRate
    }
  }

  private var formatBinding: Binding<FormatCatalogue.Option> {
    Binding(
      get: { selectedOption ?? formatOptions[0] },
      set: { option in
        draftSettings.width = option.width
        draftSettings.height = option.height
        draftSettings.frameRate = option.frameRate
      }
    )
  }

  private var codecBinding: Binding<StreamCodec> {
    Binding(
      get: { draftSettings.codec },
      set: { draftSettings.setCodec($0) }
    )
  }

  private var bitrateMbps: Double { Double(draftSettings.bitrate) / 1_000_000 }

  private var bitrateBinding: Binding<Double> {
    Binding(
      get: { bitrateMbps },
      set: { draftSettings.bitrate = Int($0 * 1_000_000) }
    )
  }

  private func copyURL() {
    UIPasteboard.general.string = environment.streamURL
    didCopyURL = true
  }

  /// Applied on the way out rather than on every keystroke: renaming per character would put a
  /// dozen half-typed names into the Keychain and announce each of them over Bonjour.
  ///
  /// The pipeline is left alone when nothing changed, so opening Settings to copy the URL does not
  /// restart the encoder.
  private func commit() {
    let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed != environment.identity.name { environment.rename(to: trimmed) }
    if draftSettings != environment.settings {
      environment.settings = draftSettings
      environment.applySettings()
    }
    dismiss()
  }
}

extension StreamCodec {
  var displayName: String {
    switch self {
    case .h264: "H.264"
    case .hevc: "HEVC"
    }
  }
}
