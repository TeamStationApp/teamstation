import CameramanCore
import SwiftUI
import UIKit

/// Name, codec, format and bitrate. Opening this sheet must not touch the pipeline; only Done
/// applies, and only when something actually changed. A reconfigure that fires because the operator
/// wanted to read the URL would look like the camera glitching.
///
/// Generic over the model for the same reason `CameraView` is: on a remote screen "Done" becomes
/// one `SET_PARAMETER` rather than an encoder reconfigure, and the sheet does not need to know.
struct SettingsView<Model: CameraControlling>: View {
  let model: Model
  @Environment(\.dismiss) private var dismiss

  @State private var draftName: String = ""
  @State private var draftSettings: StreamSettings = .default
  @FocusState private var nameFocused: Bool
  @State private var didCopyURL = false
  @State private var showingTestThermal = false
  @State private var v1Server = ""
  @State private var v1EventId = ""
  @State private var scoreboardEmail = ""
  @State private var scoreboardCode = ""
  @State private var didLoadScoreboard = false

  var body: some View {
    NavigationStack {
      // One shared scroll. Landscape: two rows of two (video/audio/output + lenses, then name +
      // stream), which is the phone's layout. Portrait, on a rotating client: the six cards
      // stacked. The draft lives above this switch, so rotating mid-edit keeps every edited value.
      GeometryReader { geo in
        let columns = SettingsLayout.columns(for: geo.size)
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            gameStationSection
            if columns == 2 {
              HStack(alignment: .top, spacing: 12) {
                VStack(spacing: 16) {
                  videoSection
                  audioSection
                  outputSection
                }
                .frame(maxWidth: .infinity, alignment: .top)
                lensesSection
                  .frame(maxWidth: .infinity, alignment: .top)
              }
              HStack(alignment: .top, spacing: 12) {
                nameSection
                serverSection
              }
            } else {
              videoSection
              audioSection
              outputSection
              lensesSection
              nameSection
              serverSection
            }
            radarSection
            scoreboardSection
            // A flow reads which layout is up. A marker rather than an identifier on the
            // container, which would hide every control inside it.
            Color.clear
              .frame(width: 1, height: 1)
              .accessibilityIdentifier(columns == 2 ? "settings-layout-landscape" : "settings-layout-portrait")
          }
          .padding(.horizontal, 12)
          .padding(.bottom, 80)
        }
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
            .foregroundStyle(Color(red: 0.50, green: 0.85, blue: 0.61))
            .accessibilityIdentifier("settings-done")
        }
      }
      .confirmationDialog(
        "Test Thermal Visuals",
        isPresented: $showingTestThermal,
        titleVisibility: .visible
      ) {
        Button("Cool") {
          model.previewThermal(.nominal)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-cool")
        Button("Fair") {
          model.previewThermal(.fair)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-fair")
        Button("Warm") {
          model.previewThermal(.serious)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-warm")
        Button("Hot") {
          model.previewThermal(.critical)
          dismiss()
        }
        .accessibilityIdentifier("settings-test-thermal-hot")
        Button("Cancel", role: .cancel) {}
      }
    }
    .onAppear {
      draftName = model.name
      draftSettings = model.settings
      didCopyURL = false
    }
  }

  /// Sign-in, alone, above every other card. The account server is the build's.
  @ViewBuilder
  private var gameStationSection: some View {
    if let board = model as? any ScoreboardControlling {
      settingsCard("GameStation") {
        if board.scoreboard.accountHost != ScoreboardTarget.productionAccountHost {
          Text(board.scoreboard.accountHost)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .accessibilityIdentifier("scoreboard-account-server")
        }
        if board.scoreboard.signedIn {
          Text(board.scoreboard.accountLabel)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .accessibilityIdentifier("scoreboard-account")
          pillButton("Sign Out", tag: "scoreboard-sign-out") {
            board.signOutScoreboard()
          }
        } else {
          cardRow {
            TextField("Email", text: $scoreboardEmail)
              .textInputAutocapitalization(.never)
              .keyboardType(.emailAddress)
              .autocorrectionDisabled()
              .accessibilityIdentifier("scoreboard-email")
          }
          pillButton("Send Code", tag: "scoreboard-send-code") {
            board.sendScoreboardCode(email: scoreboardEmail)
          }
          if board.scoreboard.awaitingCode {
            cardRow {
              TextField("Code", text: $scoreboardCode)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("scoreboard-code")
            }
            pillButton("Sign In", tag: "scoreboard-sign-in") {
              board.verifyScoreboardCode(email: scoreboardEmail, code: scoreboardCode)
            }
          }
        }
        if !board.scoreboard.status.isEmpty && !Self.isRouteStatus(board.scoreboard.status) {
          Text(board.scoreboard.status)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityIdentifier("scoreboard-account-status")
        }
      }
    }
  }

  /// Route hints belong under the scoreboard card. Sign-in answers stay with the account.
  private static func isRouteStatus(_ text: String) -> Bool {
    text == "Choose an event" || text == "Enter a V1 event id"
  }

  /// A filled capsule, so Sign In, Sign Out and Send Code read as buttons.
  private func pillButton(
    _ title: String,
    tag: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Text(title)
        .font(.body.weight(.semibold))
        .foregroundStyle(Color(red: 0.07, green: 0.14, blue: 0.09))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(
          Color(red: 0.50, green: 0.85, blue: 0.61),
          in: Capsule()
        )
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .accessibilityIdentifier(tag)
  }

  @ViewBuilder
  private var radarSection: some View {
    if let radar = model as? any RadarControlling {
      settingsCard("Radar") {
        HStack {
          Text(radar.radar.enabled ? "On" : "Off")
          Spacer()
          Toggle("Radar", isOn: Binding(
            get: { radar.radar.enabled },
            set: { radar.setRadarEnabled($0) }
          ))
          .labelsHidden()
          .accessibilityIdentifier("settings-radar-enabled")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        if radar.radar.enabled {
          if let serial = radar.radar.serial {
            Text(serial)
              .font(.body.monospaced())
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 16)
              .padding(.vertical, 6)
              .accessibilityIdentifier("settings-radar-serial")
            Text(radar.radar.status)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 16)
              .padding(.bottom, 4)
              .accessibilityIdentifier("settings-radar-status")
            if let readout = radar.radar.readout {
              Text(readout)
                .font(.title3.monospacedDigit())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
                .accessibilityIdentifier("settings-radar-speeds")
            }
            Button("Unpair") { radar.unpairRadar() }
              .padding(.horizontal, 16)
              .padding(.bottom, 8)
              .accessibilityIdentifier("settings-radar-unpair")
          } else {
            Button("Pair") { radar.openRadarPairing() }
              .padding(.horizontal, 16)
              .padding(.vertical, 8)
              .accessibilityIdentifier("settings-radar-pair")
          }
          if radar.radar.pairing {
            if radar.radar.choices.isEmpty {
              Text("No radars in range")
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            ForEach(radar.radar.choices, id: \.self) { name in
              Button(name) { radar.pairRadar(name) }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
                .accessibilityIdentifier("settings-radar-option-\(name)")
            }
            Button("Close") { radar.dismissRadarPairing() }
              .padding(.horizontal, 16)
              .padding(.bottom, 8)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var scoreboardSection: some View {
    if let board = model as? any ScoreboardControlling {
      settingsCard("Scoreboard") {
        routeButton(
          "GameStation V1",
          selected: board.scoreboard.route == .v1,
          enabled: true,
          tag: "scoreboard-route-v1"
        ) {
          board.selectScoreboardRoute(.v1)
        }
        cardRow {
          TextField("V1 server", text: $v1Server)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("scoreboard-v1-server")
            .onChange(of: v1Server) { _, value in
              guard didLoadScoreboard else { return }
              board.setScoreboardV1(apiServer: value, eventId: v1EventId)
            }
        }
        Divider().padding(.leading, 16)
        cardRow {
          TextField("V1 event id", text: $v1EventId)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("scoreboard-v1-event")
            .onChange(of: v1EventId) { _, value in
              guard didLoadScoreboard else { return }
              board.setScoreboardV1(apiServer: v1Server, eventId: value)
            }
        }
        routeButton(
          "GameStation event",
          selected: board.scoreboard.route == .event,
          enabled: board.scoreboard.signedIn,
          tag: "scoreboard-route-event"
        ) {
          board.selectScoreboardRoute(.event)
        }
        Text("Gamestation Event")
          .font(.headline)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16)
        Text("Pick event for radar data")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16)
        Button {
          board.openScoreboardEvents()
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            if !board.scoreboard.gameWhen.isEmpty {
              Text(board.scoreboard.gameWhen)
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Text(board.scoreboard.gameTitle.isEmpty ? "Tap to pick an event" : board.scoreboard.gameTitle)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .disabled(!board.scoreboard.signedIn)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .accessibilityIdentifier("scoreboard-choose-event")
        if Self.isRouteStatus(board.scoreboard.status) {
          Text(board.scoreboard.status)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityIdentifier("scoreboard-status")
        }
      }
      .onAppear {
        guard !didLoadScoreboard else { return }
        didLoadScoreboard = true
        v1Server = board.scoreboard.apiServer
        v1EventId = board.scoreboard.v1EventId
      }
      .sheet(isPresented: Binding(
        get: { board.scoreboard.pickerOpen },
        set: { if !$0 { board.dismissScoreboardEvents() } }
      )) {
        NavigationStack {
          List {
            Section("Last 3 hours") {
              if board.scoreboard.recent.isEmpty {
                Text("None")
              }
              ForEach(board.scoreboard.recent) { event in
                Button {
                  board.chooseScoreboardEvent(event.gameId)
                } label: {
                  VStack(alignment: .leading) {
                    Text(event.title)
                    Text(event.whenLabel).font(.footnote).foregroundStyle(.secondary)
                  }
                }
                .accessibilityIdentifier("scoreboard-event-\(event.gameId)")
              }
            }
            Section("Next 5") {
              if board.scoreboard.upcoming.isEmpty {
                Text("None")
              }
              ForEach(board.scoreboard.upcoming) { event in
                Button {
                  board.chooseScoreboardEvent(event.gameId)
                } label: {
                  VStack(alignment: .leading) {
                    Text(event.title)
                    Text(event.whenLabel).font(.footnote).foregroundStyle(.secondary)
                  }
                }
                .accessibilityIdentifier("scoreboard-event-\(event.gameId)")
              }
            }
          }
          .navigationTitle("Events")
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Close") { board.dismissScoreboardEvents() }
                .accessibilityIdentifier("scoreboard-events-close")
            }
          }
        }
      }
    }
  }

  private func routeButton(
    _ title: String,
    selected: Bool,
    enabled: Bool,
    tag: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack {
        Image(systemName: selected ? "largecircle.fill.circle" : "circle")
        Text(title)
        Spacer()
      }
      .foregroundStyle(enabled ? Color.primary : Color.secondary.opacity(0.45))
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityIdentifier(tag)
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
        .foregroundStyle(Color(red: 0.50, green: 0.85, blue: 0.61))
        .textCase(.uppercase)
        .padding(.horizontal, 16)
      VStack(spacing: 0) {
        content()
      }
      .background(
        Color(uiColor: .secondarySystemGroupedBackground),
        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
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
        LabeledContent("Identifier", value: model.cname)
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
          LabeledContent("Bitrate", value: bitrateLabel)
            .accessibilityIdentifier("settings-bitrate-value")
          // Swapped in place by the toggle below. Adapting, the operator sets the range the stream
          // may move in; not adapting, the one rate it runs at, and a floor on screen would be a
          // setting that does nothing.
          if draftSettings.adaptiveBitrate {
            RangeSlider(
              lower: bitrateFloorBinding,
              upper: bitrateCeilingBinding,
              in: 1 ... Double(StreamSettings.maximumBitrate) / 1_000_000,
              step: 0.5,
              tint: .green,
              lowerIdentifier: "settings-bitrate-low",
              upperIdentifier: "settings-bitrate-high",
              valueLabel: { String(format: "%.1f Mbps", $0) }
            )
          } else {
            Slider(value: bitrateBinding, in: 1 ... Double(StreamSettings.maximumBitrate) / 1_000_000, step: 0.5)
              .accessibilityIdentifier("settings-bitrate")
          }
        }
      }
      Divider().padding(.leading, 16)
      cardRow {
        VStack(alignment: .leading, spacing: 2) {
          Toggle("Adaptive bitrate", isOn: $draftSettings.adaptiveBitrate)
            .accessibilityIdentifier("settings-adaptive-bitrate")
          Text("Comes down toward the low rate only while the network cannot keep up.")
            .font(.footnote)
            .foregroundStyle(.secondary)
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

  /// Not in the Video card: the video rows all restart the encoder on Done, and this one must not
  /// read as if it did.
  private var outputSection: some View {
    settingsCard(
      "Output",
      footer: "Send the camera picture to a USB-C display with no overlays. Off shows this screen instead."
    ) {
      cardRow {
        Toggle("Clean HDMI output", isOn: $draftSettings.cleanHDMIEnabled)
          .accessibilityIdentifier("settings-clean-hdmi")
      }
    }
  }

  /// One row per physical lens. Millimetre labels come from field of view, so a 15 Pro and a 13
  /// Pro each list the cameras they actually have. Native crops such as the 2x are not listed: they
  /// are zoom stops on their lens, reached with the on-screen zoom.
  private var lensesSection: some View {
    let catalog = model.availableLenses
    let lenses = LensSelection.physical(in: catalog)
    return Group {
      if !lenses.isEmpty {
        settingsCard(
          "Lenses",
          footer: "Off keeps only the remaining cameras, so a clip-on cannot be abandoned when focus hunts."
        ) {
          ForEach(Array(lenses.enumerated()), id: \.element.id) { index, lens in
            if index > 0 { Divider().padding(.leading, 16) }
            cardRow {
              lensRow(lens, in: catalog)
            }
          }
        }
      }
    }
  }

  private func lensRow(_ lens: CameraLens, in catalog: [CameraLens]) -> some View {
    let enabled = LensSelection(disabledIDs: draftSettings.disabledLensIDs)
      .normalized(in: catalog)
      .isEnabled(lens)
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
            Text(model.streamURL)
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
      .accessibilityValue(model.streamURL)
      .padding(.horizontal, 16)
      .padding(.vertical, 10)

      Divider().padding(.leading, 16)

      cardRow {
        LabeledContent("Clients") {
          Text("\(model.clientCount)")
            .accessibilityIdentifier("settings-clients")
        }
      }
    }
  }

  // MARK: - Bindings

  /// The menu plus, when it is missing from the menu, the current setting. The catalogue is empty
  /// until the camera has been configured, and a setting that arrived by launch argument or from an
  /// earlier build need not be one the menu offers; a picker that cannot show what is selected would
  /// show the first row instead and lie about what is streaming.
  private var formatOptions: [FormatCatalogue.Option] {
    let options = model.formatOptions
    let current = FormatCatalogue.Option(
      width: draftSettings.width,
      height: draftSettings.height,
      frameRate: draftSettings.frameRate,
      supportsMultiLensSwitching: true
    )
    let isOffered = options.contains {
      $0.width == current.width && $0.height == current.height && $0.frameRate == current.frameRate
    }
    return isOffered ? options : options + [ current ]
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
  private var bitrateFloorMbps: Double { Double(draftSettings.bitrateFloor) / 1_000_000 }

  /// `2.0–8.0 Mbps` while adapting, the floor to the rate; `6.0 Mbps` otherwise.
  private var bitrateLabel: String {
    draftSettings.adaptiveBitrate
      ? String(format: "%.1f–%.1f Mbps", bitrateFloorMbps, bitrateMbps)
      : String(format: "%.1f Mbps", bitrateMbps)
  }

  /// The single slider, with adaptation off. `setBitrate`, so a floor the operator never chose keeps
  /// following the rate at half and turning adaptation on starts from there.
  private var bitrateBinding: Binding<Double> {
    Binding(
      get: { bitrateMbps },
      set: { draftSettings.setBitrate(Int($0 * 1_000_000)) }
    )
  }

  /// The range's high end. A plain assignment rather than `setBitrate`: the operator is moving one
  /// thumb, and the other must stay where they left it.
  private var bitrateCeilingBinding: Binding<Double> {
    Binding(
      get: { bitrateMbps },
      set: {
        draftSettings.bitrate = Int($0 * 1_000_000)
        draftSettings.clampFloorToCeiling()
      }
    )
  }

  private var bitrateFloorBinding: Binding<Double> {
    Binding(
      get: { bitrateFloorMbps },
      set: { draftSettings.bitrateFloor = min(Int($0 * 1_000_000), draftSettings.bitrate) }
    )
  }

  private func canToggle(_ lens: CameraLens, in catalog: [CameraLens]) -> Bool {
    let selection = LensSelection(disabledIDs: draftSettings.disabledLensIDs).normalized(in: catalog)
    return selection.isEnabled(lens) ? selection.canDisable(lens, in: catalog) : true
  }

  private func copyURL() {
    UIPasteboard.general.string = model.streamURL
    didCopyURL = true
  }

  /// Applied on the way out rather than on every keystroke: renaming per character would put a
  /// dozen half-typed names on disk and announce each of them over Bonjour.
  ///
  /// The pipeline is left alone when nothing changed, so opening Settings to copy the URL does not
  /// restart the encoder.
  private func commit() {
    let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed != model.name { model.rename(to: trimmed) }
    if draftSettings != model.settings { model.apply(draftSettings) }
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
