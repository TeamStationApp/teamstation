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
  @State private var showingTestThermal = false

  var body: some View {
    NavigationStack {
      // One shared scroll, two rows: video/audio + lenses, then name + stream.
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 16) {
              videoSection
              audioSection
            }
            .frame(maxWidth: .infinity, alignment: .top)
            lensesSection
              .frame(maxWidth: .infinity, alignment: .top)
          }
          HStack(alignment: .top, spacing: 12) {
            nameSection
            serverSection
          }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 80)
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .navigationTitle("Camera")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Test thermal") {
            showingTestThermal = true
          }
          .accessibilityIdentifier("settings-test-thermal")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { commit() }
            .accessibilityIdentifier("settings-done")
        }
      }
      .confirmationDialog(
        "Test Thermal Visuals",
        isPresented: $showingTestThermal,
        titleVisibility: .visible
      ) {
        Button("Cool") {
          environment.previewThermal(.nominal)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-cool")
        Button("Fair") {
          environment.previewThermal(.fair)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-fair")
        Button("Warm") {
          environment.previewThermal(.serious)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-warm")
        Button("Hot") {
          environment.previewThermal(.critical)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-hot")
        Button("Cancel", role: .cancel) {}
      }
    }
    .onAppear {
      draftName = environment.identity.name
      draftSettings = environment.settings
      didCopyURL = false
    }
  }

  /// Intrinsic-height grouped card so the outer ScrollView is the only scroller.
  private func settingsCard<Content: View>(
    _ title: String,
    footer: String? = nil,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(.uppercase)
        .padding(.horizontal, 16)
      VStack(spacing: 0) {
        content()
      }
      .background(
        Color(uiColor: .secondarySystemGroupedBackground),
        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
      )
      if let footer {
        Text(footer)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 16)
      }
    }
    .frame(maxWidth: .infinity, alignment: .top)
  }

  private func cardRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
    content()
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
  }

  private var nameSection: some View {
    settingsCard(
      "Name",
      footer: "Renaming does not make this a new camera in GS Director."
    ) {
      cardRow {
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
      }
      .onChange(of: nameFocused) { _, focused in
        guard focused else { return }
        DispatchQueue.main.async {
          UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil)
        }
      }
      Divider().padding(.leading, 16)
      cardRow {
        LabeledContent("Identifier", value: environment.identity.cname)
          .font(.system(.footnote, design: .monospaced))
          .accessibilityIdentifier("settings-cname")
      }
    }
  }

  private var videoSection: some View {
    settingsCard("Video") {
      cardRow {
        Picker("Codec", selection: codecBinding) {
          ForEach(StreamCodec.allCases, id: \.self) { codec in
            Text(codec.displayName).tag(codec)
          }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("settings-codec")
      }
      Divider().padding(.leading, 16)
      cardRow {
        Picker("Resolution", selection: formatBinding) {
          ForEach(formatOptions, id: \.self) { option in
            Text(option.label).tag(option)
          }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("settings-format")
      }
      Divider().padding(.leading, 16)
      cardRow {
        VStack(alignment: .leading, spacing: 4) {
          LabeledContent("Bitrate", value: String(format: "%.1f Mbps", bitrateMbps))
            .accessibilityIdentifier("settings-bitrate-value")
          Slider(value: bitrateBinding, in: 1 ... 50, step: 0.5)
            .accessibilityIdentifier("settings-bitrate")
        }
      }
      if let annotation = selectedOption?.annotation {
        Text(annotation)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("settings-format-note")
          .padding(.horizontal, 16)
          .padding(.bottom, 10)
      }
    }
  }

  private var audioSection: some View {
    settingsCard("Audio") {
      cardRow {
        Toggle("Microphone", isOn: $draftSettings.audioEnabled)
          .accessibilityIdentifier("settings-audio")
      }
    }
  }

  /// One row per detected lens. Millimetre labels come from field of view, so a 15 Pro and a 13
  /// Pro each list the cameras they actually have.
  private var lensesSection: some View {
    let lenses = environment.cameraState.availableLenses
    return Group {
      if !lenses.isEmpty {
        settingsCard(
          "Lenses",
          footer: "Off keeps only the remaining cameras, so a clip-on cannot be abandoned when focus hunts."
        ) {
          ForEach(Array(lenses.enumerated()), id: \.element.id) { index, lens in
            if index > 0 { Divider().padding(.leading, 16) }
            cardRow {
              lensRow(lens, in: lenses)
            }
          }
        }
      }
    }
  }

  private func lensRow(_ lens: CameraLens, in catalog: [CameraLens]) -> some View {
    let enabled = !draftSettings.disabledLensIDs.contains(lens.id)
    let interactive = canToggle(lens, in: catalog) || !enabled
    return Toggle(isOn: Binding(
      get: { enabled },
      set: { newValue in
        guard interactive else { return }
        draftSettings.disabledLensIDs = LensSelection(disabledIDs: draftSettings.disabledLensIDs)
          .toggling(lens, to: newValue, in: catalog)
          .disabledIDs
      }
    )) {
      Text(lens.settingsLabel)
        .lineLimit(1)
        .minimumScaleFactor(0.65)
    }
    .disabled(!interactive)
    .accessibilityIdentifier(lens.accessibilityIdentifier)
    .accessibilityHint(lens.subtitle)
  }

  private var serverSection: some View {
    settingsCard("Stream") {
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
      .padding(.horizontal, 16)
      .padding(.vertical, 10)

      Divider().padding(.leading, 16)

      cardRow {
        LabeledContent("Clients") {
          Text("\(environment.serverStatus.clientCount)")
            .accessibilityIdentifier("settings-clients")
        }
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

  private func canToggle(_ lens: CameraLens, in catalog: [CameraLens]) -> Bool {
    let selection = LensSelection(disabledIDs: draftSettings.disabledLensIDs)
    return selection.isEnabled(lens) ? selection.canDisable(lens, in: catalog) : true
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
