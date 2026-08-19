import CameramanCapture
import CameramanCore
import SwiftUI

/// Name, codec, format and bitrate. Everything here restarts part of the pipeline, so it is a sheet
/// the operator leaves rather than a panel over the picture: changing the resolution mid-play would
/// otherwise look like the camera glitching.
struct SettingsView: View {
  @Bindable var environment: AppEnvironment
  @Environment(\.dismiss) private var dismiss

  @State private var draftName: String = ""

  var body: some View {
    NavigationStack {
      // Two columns because the app is landscape-only: a single form on an 844x390 screen puts
      // everything below the bitrate off the bottom, and a settings sheet whose settings have to be
      // scrolled for is one whose settings do not get found.
      HStack(alignment: .top, spacing: 0) {
        Form {
          nameSection
          serverSection
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
    .onAppear { draftName = environment.identity.name }
  }

  private var nameSection: some View {
    Section {
      TextField("Camera name", text: $draftName)
        .textInputAutocapitalization(.words)
        .autocorrectionDisabled()
        .accessibilityIdentifier("settings-name-field")

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
      Picker("Codec", selection: $environment.settings.codec) {
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
      Toggle("Microphone", isOn: $environment.settings.audioEnabled)
        .accessibilityIdentifier("settings-audio")
    }
  }

  private var serverSection: some View {
    Section("Stream") {
      LabeledContent("Address", value: environment.streamURL)
        .font(.system(.footnote, design: .monospaced))
        .accessibilityIdentifier("settings-url")
      LabeledContent("Clients", value: "\(environment.serverStatus.clientCount)")
        .accessibilityIdentifier("settings-clients")
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
      width: environment.settings.width,
      height: environment.settings.height,
      frameRate: environment.settings.frameRate,
      supportsMultiLensSwitching: true
    ) ]
  }

  private var selectedOption: FormatCatalogue.Option? {
    formatOptions.first {
      $0.width == environment.settings.width
        && $0.height == environment.settings.height
        && $0.frameRate == environment.settings.frameRate
    }
  }

  private var formatBinding: Binding<FormatCatalogue.Option> {
    Binding(
      get: { selectedOption ?? formatOptions[0] },
      set: { option in
        environment.settings.width = option.width
        environment.settings.height = option.height
        environment.settings.frameRate = option.frameRate
      }
    )
  }

  private var bitrateMbps: Double { Double(environment.settings.bitrate) / 1_000_000 }

  private var bitrateBinding: Binding<Double> {
    Binding(
      get: { bitrateMbps },
      set: { environment.settings.bitrate = Int($0 * 1_000_000) }
    )
  }

  /// Applied on the way out rather than on every keystroke: renaming per character would put a
  /// dozen half-typed names into the Keychain and announce each of them over Bonjour.
  private func commit() {
    let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed != environment.identity.name { environment.rename(to: trimmed) }
    environment.applySettings()
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
