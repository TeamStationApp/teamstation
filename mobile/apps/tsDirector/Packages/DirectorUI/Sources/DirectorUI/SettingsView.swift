import CameramanControlUI
import CameramanCore
import DirectorCore
import TeamStationKit
import SwiftUI

private enum SettingsCover: String, Identifiable {
  case contentEditor
  case remoteEditor
  case newTemplate
  case newRemote
  /// The games this Director may film, to choose the stream's destination from.
  case eventPicker
  /// Signing in to the TeamStation account whose games the picker lists.
  case teamStationSignIn

  var id: String { rawValue }
}

public struct SettingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var draft = AppConfig.default
  @State private var cover: SettingsCover?
  @State private var logout = LoginFlow()
  @State private var showingClearCameraMemory = false
  @State private var showingTestThermal = false
  @State private var deleting: OverlayTemplate?
  @State private var newTemplateName = ""
  @State private var copyFromID: UUID?
  @State private var deletingRemote: RemoteControlTemplate?
  @State private var newRemoteName = ""
  @State private var copyRemoteFromID: UUID?

  public init() {}

  public var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      settingsForm
        .stackedBehind(depth: cover == nil ? 0 : 1)
        .accessibilityHidden(cover != nil)
        .allowsHitTesting(cover == nil)
        // A tap off the slide disarms an armed logout. A Form row button with
        // the default style never runs under this gesture, and neither does a
        // menu Picker — every codec, resolution and frame-rate dropdown went
        // dead — so the gesture exists only while there is a slide to disarm.
        .simultaneousGesture(
          TapGesture().onEnded { logout.tapElsewhere() },
          including: logout.logoutArmed ? .all : .subviews
        )

      if let cover {
        StackedSceneLayer(onDismiss: dismissCover) {
          settingsCover(cover)
        }
        .id(cover.id)
      }
    }
    .task {
      // Who this Director is signed in to TeamStation as. Asked here rather
      // than at launch: nothing before this screen needs it — the chosen
      // game's URL comes out of the keychain — and a network call on the
      // launch path is a call made at a ball field with no signal, in front
      // of the watchdog.
      await environment.teamStation.restore()
    }
    .animation(StackedScene.animation, value: cover)
    .alert(
      "Delete template?",
      isPresented: Binding(
        get: { deleting != nil },
        set: { if !$0 { deleting = nil } }
      )
    ) {
      Button("Delete", role: .destructive) {
        if let deleting {
          environment.deleteTemplate(id: deleting.id)
        }
        deleting = nil
      }
      .accessibilityIdentifier("settings-content-template-delete-confirm")
      Button("Cancel", role: .cancel) { deleting = nil }
    } message: {
      Text("Removes “\(deleting?.name ?? "")” from Output.")
    }
    .alert(
      "Delete remote template?",
      isPresented: Binding(
        get: { deletingRemote != nil },
        set: { if !$0 { deletingRemote = nil } }
      )
    ) {
      Button("Delete", role: .destructive) {
        if let deletingRemote {
          environment.deleteRemoteTemplate(id: deletingRemote.id)
        }
        deletingRemote = nil
      }
      .accessibilityIdentifier("settings-remote-template-delete-confirm")
      Button("Cancel", role: .cancel) { deletingRemote = nil }
    } message: {
      Text("Removes “\(deletingRemote?.name ?? "")” from Remote Control.")
    }
    .confirmationDialog(
      "Clear camera memory?",
      isPresented: $showingClearCameraMemory,
      titleVisibility: .visible
    ) {
      Button("Clear camera memory", role: .destructive) {
        environment.clearCameraMemory()
      }
      .accessibilityIdentifier("settings-clear-camera-memory-confirm")
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Removes every saved camera name and mapping. Cameras without a NearStream serial/MAC "
          + "or an RTSP identifier will not be remembered."
      )
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
    .onAppear {
      draft = environment.persistedConfig
      draft.replaySlowMotionRate = environment.persistedConfig.replaySlowMotionRate * 100
      draft.useSimulatedCameras = environment.isUsingSimulatedCameras
      draft.showDebugHUD = environment.config.showDebugHUD
      environment.cameraNameForClaim = draft.cameraName
    }
  }

  private var settingsForm: some View {
    NavigationStack {
      Form {
        // The account, first and alone, because it is not a streaming
        // setting. Somebody signs in once; where the Stream button publishes
        // is a separate decision, made in the section below, and a Director
        // that is signed in may still be streaming to a typed URL. Buried in
        // the stream section, signing in looked like part of choosing a
        // destination, and an operator who wanted neither had nowhere obvious
        // to go.
        Section {
          if LoginFlow.showsDevelopmentHost(AppServer.url.absoluteString) {
            Text(AppServer.url.absoluteString)
              .font(.footnote)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("settings-teamstation-host")
          }
          accountRow
        } header: {
          Text(environment.teamStation.isSignedIn
            ? "TeamStation account"
            : "Log in to TeamStation")
        }

        Section {
          teamStationEventRow
        } header: {
          Text("TeamStation Event")
        } footer: {
          Text("Pick event for video stream and scoreboard overlay")
        }

        Section {
          // Two destinations, one chosen. The event is first because it is
          // the one somebody uses every week; the typed URL is what a one-off
          // to somebody else's service needs, and it keeps working exactly as
          // it did for every Director that already has one.
          streamEventRow

          if draft.streamDestination == .event {
            TextField("Camera name", text: $draft.cameraName)
              .textInputAutocapitalization(.words)
              .autocorrectionDisabled()
              .accessibilityIdentifier("settings-camera-name")
              .onChange(of: draft.cameraName) { _, name in
                environment.cameraNameForClaim = name
              }
          }

          HStack(spacing: 12) {
            destinationButton(.url, label: "Use a stream URL")
            ClearableTextField(
              text: $draft.streamURL,
              clearIdentifier: "settings-stream-url-clear",
              clearLabel: "Clear stream URL"
            ) {
              TextField("rtmp://host:1935/live/key", text: $draft.streamURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("settings-stream-url")
            }
          }

          Picker("Codec", selection: $draft.streamCodec) {
            ForEach(ProgramCodec.allCases, id: \.self) { codec in
              Text(codec.displayName).tag(codec)
            }
          }
          .accessibilityIdentifier("settings-stream-codec")

          Picker("Resolution", selection: $draft.streamResolution) {
            Text("1080p").tag(ProgramResolution.hd1080)
            Text("720p").tag(ProgramResolution.hd720)
          }
          .accessibilityIdentifier("settings-stream-resolution")

          Picker("Frame rate", selection: $draft.streamFrameRate) {
            ForEach(AppConfig.frameRateChoices, id: \.self) { rate in
              Text("\(rate) fps").tag(rate)
            }
          }
          .accessibilityIdentifier("settings-stream-framerate")

          StreamBitrateRange(low: $draft.streamBitrateLow, high: $draft.streamBitrateHigh)
        } header: {
          Text("Programme master stream")
        } footer: {
          Text("""
          Where the Stream button publishes the programme, and how that stream is encoded. Choose \
          a TeamStation event and the app holds its address for you. The stream URL is for publishing \
          somewhere else, and is typed in full. The bitrate starts at the high point and comes \
          down towards the low one while the network cannot keep up, rather than drop frames. \
          HEVC needs a service that takes Enhanced RTMP; choose H.264 for one that does not.
          """)
        }

        Section {
          ReplaySlowMotionSlider(percent: $draft.replaySlowMotionRate)
        } header: {
          Text("Instant replay")
        } footer: {
          Text("Slow-motion buttons play at this percent of live speed. 50 is half speed.")
        }

        Section {
          ForEach(Array(environment.templates.enumerated()), id: \.element.id) { index, template in
            SettingsTemplateRow(
              name: template.name,
              isSelected: template.id == environment.activeTemplateID,
              selectIdentifier: "settings-content-template-select-\(index + 1)",
              nameIdentifier: "settings-content-template-\(index + 1)",
              deleteIdentifier: "settings-content-template-delete-\(index + 1)",
              onSelect: { environment.selectTemplate(id: template.id) },
              onEdit: {
                environment.beginEditingTemplate(id: template.id)
                cover = .contentEditor
              },
              onDelete: { deleting = template }
            )
          }

          Button {
            copyFromID = environment.activeTemplateID
            newTemplateName = ""
            cover = .newTemplate
          } label: {
            Text("Add New Template")
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.borderless)
          .accessibilityIdentifier("settings-add-content-template")
        } header: {
          Text("Content Templates")
        } footer: {
          Text("Radio selects the Output template. Tap the name to edit. Trash deletes.")
        }

        Section {
          ForEach(Array(environment.remoteTemplates.enumerated()), id: \.element.id) { index, template in
            SettingsTemplateRow(
              name: template.name,
              isSelected: template.id == environment.activeRemoteTemplateID,
              selectIdentifier: "settings-remote-template-select-\(index + 1)",
              nameIdentifier: "settings-remote-template-\(index + 1)",
              deleteIdentifier: "settings-remote-template-delete-\(index + 1)",
              onSelect: { environment.selectRemoteTemplate(id: template.id) },
              onEdit: {
                environment.beginEditingRemoteTemplate(id: template.id)
                cover = .remoteEditor
              },
              onDelete: { deletingRemote = template }
            )
          }

          Button {
            copyRemoteFromID = environment.activeRemoteTemplateID
            newRemoteName = ""
            cover = .newRemote
          } label: {
            Text("Add New Template")
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.borderless)
          .accessibilityIdentifier("settings-add-remote-template")
        } header: {
          Text("Remote Control")
        } footer: {
          Text("Radio selects the pad mapping. Tap the name to edit. Trash deletes.")
        }

        Section {
          Picker("Codec", selection: $draft.rawCameraCodec) {
            ForEach(ProgramCodec.allCases, id: \.self) { codec in
              Text(codec.displayName).tag(codec)
            }
          }
          .accessibilityIdentifier("settings-raw-codec")

          Picker("Resolution", selection: $draft.rawCameraResolution) {
            Text("1080p").tag(ProgramResolution.hd1080)
            Text("720p").tag(ProgramResolution.hd720)
          }
          .accessibilityIdentifier("settings-raw-resolution")

          Picker("Frame rate", selection: $draft.rawCameraFrameRate) {
            ForEach(AppConfig.frameRateChoices, id: \.self) { rate in
              Text("\(rate) fps").tag(rate)
            }
          }
          .accessibilityIdentifier("settings-raw-framerate")

          Stepper(
            "Bitrate \(draft.rawCameraBitrate / 1_000_000) Mbps",
            value: $draft.rawCameraBitrate,
            in: AppConfig.rawCameraBitrateMinimum ... AppConfig.rawCameraBitrateMaximum,
            step: 1_000_000
          )
          .accessibilityIdentifier("settings-raw-bitrate")

          Stepper(
            "Segment \(Int(draft.segmentSeconds))s",
            value: $draft.segmentSeconds,
            in: 2 ... 30,
            step: 1
          )
          .accessibilityIdentifier("settings-segment")
        } header: {
          Text("Raw camera encoding")
        } footer: {
          Text("""
          How an NDI camera is recorded, and how every exported camera file is made. An RTSP camera \
          is recorded exactly as it sends it; only its export is encoded with these settings. \
          Whatever frame rate a camera sent comes out at the one chosen here, with any picture it \
          did not send repeated. Segments end on the camera's own keyframes, so they run slightly \
          longer than the length above.
          """)
        }

        Section {
          Picker("Codec", selection: $draft.programCodec) {
            ForEach(ProgramCodec.allCases, id: \.self) { codec in
              Text(codec.displayName).tag(codec)
            }
          }
          .accessibilityIdentifier("settings-codec")

          Picker("Resolution", selection: $draft.programResolution) {
            Text("1080p").tag(ProgramResolution.hd1080)
            Text("720p").tag(ProgramResolution.hd720)
          }
          .accessibilityIdentifier("settings-resolution")

          Stepper(
            "Bitrate \(draft.programBitrate / 1_000_000) Mbps",
            value: $draft.programBitrate,
            in: 2_000_000 ... 40_000_000,
            step: 1_000_000
          )
          .accessibilityIdentifier("settings-bitrate")

          Picker("Frame rate", selection: $draft.programFrameRate) {
            Text("15 fps").tag(15)
            Text("30 fps").tag(30)
            Text("60 fps").tag(60)
          }
          .accessibilityIdentifier("settings-framerate")
        } header: {
          Text("Programme master recording")
        } footer: {
          Text("""
          The programme master is a composite — cut, overlays and mixed audio — so it is always \
          encoded. These settings apply to the recorded master, and to a programme export that has \
          to be encoded again.
          """)
        }

        Section {
          Stepper(
            "Keep up to \(Self.gigabytes(draft.maximumArchiveBytes)) of camera archive",
            value: Binding(
              get: { Double(draft.maximumArchiveBytes) / Double(AppConfig.gigabyte) },
              set: { draft.maximumArchiveBytes = Int64($0.rounded()) * AppConfig.gigabyte }
            ),
            in: 10 ... 900,
            step: 10
          )
          .accessibilityIdentifier("settings-retention")

          Stepper(
            "Sweep when free space drops under \(Self.gigabytes(draft.freeDiskFloorBytes))",
            value: Binding(
              get: { Double(draft.freeDiskFloorBytes) / Double(AppConfig.gigabyte) },
              set: { draft.freeDiskFloorBytes = Int64($0.rounded()) * AppConfig.gigabyte }
            ),
            in: 10 ... 500,
            step: 10
          )
          .accessibilityIdentifier("settings-retention-floor")

          LabeledContent("Free space", value: Self.gigabytes(DirectorPaths.freeDiskBytes()))
            .accessibilityIdentifier("settings-free-space")
        } header: {
          Text("Retention")
        } footer: {
          Text("""
          Oldest recordings lose their camera archive first, whole takes at a time. The \
          programme master and anything already exported are never swept — delete those \
          yourself from Recordings.
          """)
        }

        Section {
          Toggle("Scan a different subnet", isOn: $draft.subnetScanOverrideEnabled)
            .accessibilityIdentifier("settings-subnet-scan-enabled")
          TextField("10.10.6.0, 10.10.7.0", text: $draft.subnetScanOverride)
            .keyboardType(.numbersAndPunctuation)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .foregroundStyle(draft.subnetScanOverrideEnabled ? .primary : .secondary)
            .accessibilityIdentifier("settings-subnet-scan")
          if draft.subnetScanOverrideEnabled,
             AppConfig.scanSubnetNetworkAddresses(draft.subnetScanOverride) == nil {
            Text("Enter one or two subnets, comma-separated, like 10.10.6.0, 10.10.7.0.")
              .font(.footnote)
              .foregroundStyle(.red)
              .accessibilityIdentifier("settings-subnet-scan-invalid")
          }
        } header: {
          Text("Camera discovery")
        } footer: {
          Text("""
          When on, the camera search sweeps every address (.1 to .254) of up to two subnets, \
          comma-separated, instead of this iPad's own. Turn it off for normal use; the subnets are \
          kept for next time.
          """)
        }

        Section {
          Toggle("Cap preview latency", isOn: $draft.displayLatencyCapEnabled)
            .accessibilityIdentifier("settings-display-latency-cap-enabled")
          if draft.displayLatencyCapEnabled {
            LatencyCapSlider(
              title: "Preview",
              milliseconds: $draft.displayLatencyCapMilliseconds,
              range: AppConfig.displayLatencyCapMinimumMilliseconds
                ... AppConfig.displayLatencyCapMaximumMilliseconds,
              step: 10,
              identifier: "settings-display-latency-cap"
            )
          }

          Toggle("Cap recording latency", isOn: $draft.diskLatencyCapEnabled)
            .accessibilityIdentifier("settings-disk-latency-cap-enabled")
          if draft.diskLatencyCapEnabled {
            LatencyCapSlider(
              title: "Recording",
              milliseconds: $draft.diskLatencyCapMilliseconds,
              range: AppConfig.diskLatencyCapMinimumMilliseconds
                ... AppConfig.diskLatencyCapMaximumMilliseconds,
              step: 100,
              identifier: "settings-disk-latency-cap"
            )
          }
        } header: {
          Text("Latency")
        } footer: {
          Text(
            "How old a picture may be and still be used, measured from when it was taken. "
              + "The preview is worthless showing action that has already happened, so a picture "
              + "past its cap is held and the last good frame stays up. The recording is watched "
              + "afterwards, where a late picture is simply a picture and dropping it leaves a "
              + "hole in the tape — so give it the longer allowance. Off means no ceiling."
          )
        }

        Section {
          Text("""
          Recording to external storage is not supported. TS Director writes to the iPad's \
          internal storage only, and stops archiving when free space drops below the headroom \
          guard rather than filling the device.
          """)
          .font(.footnote)
          .foregroundStyle(.secondary)
        } header: {
          Text("Storage")
        }

        Section {
          Toggle("Simulated cameras", isOn: $draft.useSimulatedCameras)
            .accessibilityIdentifier("settings-simulated-cameras")

          Button("Clear camera memory", role: .destructive) {
            showingClearCameraMemory = true
          }
          .buttonStyle(.borderless)
          .accessibilityIdentifier("settings-clear-camera-memory")
        } header: {
          Text("Sources")
        } footer: {
          Text(
            "On: generated test patterns. Off: cameras on the network. "
              + "Takes effect when you Save — no rebuild. "
              + "Clear camera memory forgets every named camera. Only cameras with a NearStream "
              + "serial/MAC or an RTSP identifier are remembered after that."
          )
        }

        Section {
          Toggle("Telemetry overlay", isOn: $draft.showDebugHUD)
            .accessibilityIdentifier("settings-debug-hud")

          Button("Test Thermal Visuals") {
            showingTestThermal = true
          }
          .buttonStyle(.borderless)
          .accessibilityIdentifier("settings-test-thermal")
        } header: {
          Text("Diagnostics")
        } footer: {
          Text(
            "Test Thermal Visuals shows Cool, Fair, Warm, or Hot on the header for ten seconds, "
              + "then returns to the device thermal level. Does not Save these Settings."
          )
          Color.clear.frame(height: 72)
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        ModalActionFooter(
          cancelTitle: "CANCEL",
          cancelIdentifier: "settings-cancel",
          onCancel: { dismiss() },
          primaryTitle: "SAVE",
          primaryIdentifier: "settings-save",
          action: {
            draft.replaySlowMotionRate = AppConfig.clampedReplaySlowMotionRate(
              draft.replaySlowMotionRate / 100
            )
            environment.update(config: draft)
            dismiss()
          }
        )
      }
    }
    .background(Color.deckBackground)
  }

  private func dismissCover() {
    cover = nil
    environment.endEditingTemplate()
    environment.endEditingRemoteTemplate()
  }

  // MARK: - The account

  private var accountEmail: String {
    environment.teamStation.user?.email
      ?? environment.teamStation.user?.displayName
      ?? ""
  }

  @ViewBuilder
  private var accountRow: some View {
    if environment.teamStation.isSignedIn {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(LoginFlow.loggedInLine(accountEmail))
            .font(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { logout.tapElsewhere() }
            .accessibilityIdentifier("settings-teamstation-account")
          if !logout.logoutArmed {
            Button("Logout") {
              logout.armLogout()
              // The form's tap-elsewhere gesture is off until this arms it, so
              // this tap never reaches it and there is nothing to swallow.
              logout.swallowNextDisarm = false
            }
            // Nested in the account row, and under the form's tap-elsewhere
            // gesture. Without its own style the tap never arms the slide.
            .buttonStyle(.borderless)
            .font(.body.weight(.semibold))
            .foregroundStyle(.red)
            .accessibilityIdentifier("teamstation-sign-out")
          }
        }
        if logout.logoutArmed {
          SlideToStopOverlay(
            phrase: "Slide to log out",
            trackIdentifier: "teamstation-slide-logout",
            onStop: {
              if logout.slide(progress: 1) {
                environment.teamStation.signOut()
              }
            }
          )
          .frame(maxWidth: .infinity, alignment: .trailing)
        }
      }
    } else {
      Button {
        cover = .teamStationSignIn
      } label: {
        Text("Tap to Login")
          .font(.body)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("settings-teamstation-account")
    }
  }

  // MARK: - The event

  /// The game this Director is covering. Tapping the row opens the list; the
  /// Clear button beside it forgets the game.
  @ViewBuilder
  private var teamStationEventRow: some View {
    let chosen = environment.teamStation.chosen
    HStack(spacing: 12) {
      Button {
        cover = environment.teamStation.isSignedIn
          ? .eventPicker
          : .teamStationSignIn
      } label: {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            if let chosen {
              Text(TeamStationEventPicker.when(chosen.startAt))
                .font(.caption)
                .foregroundStyle(.secondary)
              Text(chosen.title)
                .foregroundStyle(.primary)
            } else {
              Text("Tap to pick an event")
                .foregroundStyle(.primary)
            }
          }
          Spacer()
          Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("settings-teamstation-event")

      if chosen != nil {
        Button("Clear", role: .destructive) {
          environment.clearEvent()
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("settings-teamstation-event-clear")
      }
    }
  }

  // MARK: - Where the stream goes

  /// The radio for "the TeamStation event", which is picked in the section
  /// above.
  @ViewBuilder
  private var streamEventRow: some View {
    let chosen = environment.teamStation.chosen
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 12) {
        destinationButton(.event, label: "Use a TeamStation event")
        Text("TeamStation event — \(chosen?.title ?? "pick one above")")
          .foregroundStyle(.primary)
        Spacer()
      }

      if let message = environment.teamStation.lastError {
        Text(message)
          .font(.caption)
          .foregroundStyle(.red)
      }
    }
  }

  /// The radio that says which destination the Stream button uses.
  private func destinationButton(
    _ destination: StreamDestination,
    label: String
  ) -> some View {
    Button {
      draft.streamDestination = destination
      environment.streamDestinationChanged(to: destination)
    } label: {
      Image(
        systemName: draft.streamDestination == destination
          ? "largecircle.fill.circle"
          : "circle"
      )
      .font(.title3)
      .foregroundStyle(draft.streamDestination == destination ? Color.accentColor : .secondary)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityAddTraits(
      draft.streamDestination == destination ? [.isSelected] : []
    )
    .accessibilityIdentifier(
      destination == .event
        ? "settings-stream-destination-event"
        : "settings-stream-destination-url"
    )
  }

  @ViewBuilder
  private func settingsCover(_ item: SettingsCover) -> some View {
    switch item {
    case .contentEditor:
      ContentEditorView(onClose: dismissCover)
        .environment(environment)
    case .remoteEditor:
      RemoteControlEditorView(onClose: dismissCover)
        .environment(environment)
    case .eventPicker:
      TeamStationEventPicker(
        destination: draft.streamDestination,
        onChosen: dismissCover,
        onCancel: dismissCover
      )
        .environment(environment)
    case .teamStationSignIn:
      TeamStationSignIn(onClose: dismissCover)
        .environment(environment)
    case .newRemote:
      NewTemplateSheet(
        templates: environment.remoteTemplates.map {
          OverlayTemplate(id: $0.id, name: $0.name)
        },
        copyFromID: $copyRemoteFromID,
        name: $newRemoteName,
        onClose: dismissCover,
        onCreate: { sourceID in
          let created: UUID?
          if let sourceID {
            created = environment.duplicateRemoteTemplate(from: sourceID, name: newRemoteName)
          } else {
            created = environment.createRemoteTemplate(name: newRemoteName)
          }
          if let created {
            environment.beginEditingRemoteTemplate(id: created)
            cover = .remoteEditor
          }
        }
      )
    case .newTemplate:
      NewTemplateSheet(
        templates: environment.templates,
        copyFromID: $copyFromID,
        name: $newTemplateName,
        onClose: dismissCover,
        onCreate: { sourceID in
          let created: UUID?
          if let sourceID {
            created = environment.duplicateTemplate(from: sourceID, name: newTemplateName)
          } else {
            created = environment.createTemplate(name: newTemplateName)
          }
          if let created {
            environment.beginEditingTemplate(id: created)
            cover = .contentEditor
          }
        }
      )
    }
  }

  private static func gigabytes(_ bytes: Int64) -> String {
    String(format: "%.1f GB", Double(bytes) / 1_073_741_824)
  }
}

private struct NewTemplateSheet: View {
  enum Source: String, Hashable {
    case blank
    case copy
  }

  let templates: [OverlayTemplate]
  @Binding var copyFromID: UUID?
  @Binding var name: String
  let onClose: () -> Void
  let onCreate: (UUID?) -> Void
  @State private var source: Source = .copy

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Create as", selection: $source) {
            Text("Blank").tag(Source.blank)
            Text("Copy from").tag(Source.copy)
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("settings-new-template-source")
        }
        if source == .copy {
          Section("Copy from") {
            Picker("Template", selection: $copyFromID) {
              ForEach(templates) { template in
                Text(template.name).tag(Optional(template.id))
              }
            }
            .labelsHidden()
            .pickerStyle(.inline)
            .accessibilityIdentifier("settings-new-template-copy-from")
          }
        }
        Section("Name") {
          ClearableTextField(
            text: $name,
            clearIdentifier: "settings-new-template-name-clear"
          ) {
            TextField("Name", text: $name)
              .accessibilityIdentifier("settings-new-template-name")
          }
        }
      }
      .navigationTitle("New template")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        ModalActionFooter(
          cancelTitle: "CANCEL",
          cancelIdentifier: "settings-new-template-cancel",
          onCancel: onClose,
          primaryTitle: "CREATE",
          primaryIdentifier: "settings-new-template-create",
          primaryEnabled: canCreate,
          action: { onCreate(source == .copy ? copyFromID : nil) }
        )
      }
    }
  }

  private var canCreate: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (source != .copy || copyFromID != nil)
  }
}

/// The stream's low and high bitrate on one track: 1 to 10 Mbps in half-megabit steps, with the range
/// the bitrate may move in shown in green between the two points.
private struct StreamBitrateRange: View {
  @Binding var low: Int
  @Binding var high: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Bitrate \(Self.megabits(low))–\(Self.megabits(high)) Mbps")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("settings-stream-bitrate-value")
      RangeSlider(
        lower: Self.megabitBinding($low),
        upper: Self.megabitBinding($high),
        in: Double(AppConfig.streamBitrateMinimum) / 1_000_000 ... Double(AppConfig.streamBitrateMaximum) / 1_000_000,
        step: Double(AppConfig.streamBitrateStep) / 1_000_000,
        tint: .green,
        lowerIdentifier: "settings-stream-bitrate-low",
        upperIdentifier: "settings-stream-bitrate-high",
        valueLabel: { "\(Self.megabits(Int(($0 * 1_000_000).rounded()))) megabits per second" }
      )
    }
  }

  private static func megabitBinding(_ bits: Binding<Int>) -> Binding<Double> {
    Binding(
      get: { Double(bits.wrappedValue) / 1_000_000 },
      set: { bits.wrappedValue = Int(($0 * 1_000_000).rounded()) }
    )
  }

  /// "4" for a whole number of megabits, "2.5" otherwise.
  static func megabits(_ bits: Int) -> String {
    let value = Double(bits) / 1_000_000
    return value == value.rounded() ? "\(Int(value))" : String(format: "%.1f", value)
  }
}

/// 0–100 percent of live speed, with a tick every 10 and a taller mark every 25.
/// One latency ceiling, in whatever unit reads naturally for its range.
///
/// Milliseconds below a couple of seconds, seconds above: 10-2000 ms and 0.1-60 s have no useful
/// scale between them, which is why these are two sliders rather than one.
private struct LatencyCapSlider: View {
  var title: String
  @Binding var milliseconds: Double
  var range: ClosedRange<Double>
  var step: Double
  var identifier: String

  private var label: String {
    milliseconds >= 2_000
      ? String(format: "%@ up to %.1f s", title, milliseconds / 1_000)
      : "\(title) up to \(Int(milliseconds.rounded())) ms"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("\(identifier)-value")
      Slider(value: $milliseconds, in: range, step: step)
        .accessibilityIdentifier(identifier)
    }
  }
}

private struct ReplaySlowMotionSlider: View {
  @Binding var percent: Double

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("\(Int(percent.rounded()))%")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("settings-replay-slowmo-value")

      VStack(spacing: 4) {
        Slider(value: $percent, in: 0 ... 100, step: 1)
          .accessibilityIdentifier("settings-replay-slowmo")

        GeometryReader { geo in
          ZStack(alignment: .bottomLeading) {
            ForEach(Array(stride(from: 0.0, through: 100, by: 10)), id: \.self) { tick in
              Rectangle()
                .fill(Color.secondary.opacity(isMajor(tick) ? 0.75 : 0.35))
                .frame(width: 1, height: isMajor(tick) ? 12 : 6)
                .offset(x: tick / 100 * geo.size.width)
            }
          }
        }
        .frame(height: 12)
        .padding(.horizontal, 4)

        HStack {
          Text("0")
          Spacer()
          Text("100")
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
      }
    }
  }

  private func isMajor(_ tick: Double) -> Bool {
    tick == 0 || tick == 100 || tick.truncatingRemainder(dividingBy: 25) == 0
  }
}
