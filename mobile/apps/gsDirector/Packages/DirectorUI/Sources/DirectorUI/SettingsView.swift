import DirectorCore
import SwiftUI

public struct SettingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var draft = AppConfig.default
  @State private var showingContentEditor = false
  @State private var showingRemoteEditor = false
  @State private var showingClearCameraMemory = false
  @State private var renaming: OverlayTemplate?
  @State private var renameText = ""
  @State private var deleting: OverlayTemplate?
  @State private var showingNewTemplate = false
  @State private var newTemplateName = ""
  @State private var copyFromID: UUID?
  @State private var renamingRemote: RemoteControlTemplate?
  @State private var renameRemoteText = ""
  @State private var deletingRemote: RemoteControlTemplate?
  @State private var showingNewRemote = false
  @State private var newRemoteName = ""
  @State private var copyRemoteFromID: UUID?

  public init() {}

  public var body: some View {
    NavigationStack {
      Form {
        Section {
          ReplaySlowMotionSlider(percent: $draft.replaySlowMotionRate)
        } header: {
          Text("Instant replay")
        } footer: {
          Text("Slow-motion buttons play at this percent of live speed. 50 is half speed.")
        }

        Section {
          ForEach(Array(environment.templates.enumerated()), id: \.element.id) { index, template in
            HStack {
              Button {
                environment.selectTemplate(id: template.id)
              } label: {
                Image(
                  systemName: template.id == environment.activeTemplateID
                    ? "circle.inset.filled"
                    : "circle"
                )
              }
              .buttonStyle(.borderless)
              .padding(.trailing, 12)
              .accessibilityLabel("Select \(template.name)")
              .accessibilityIdentifier("settings-content-template-select-\(index + 1)")

              Button {
                environment.selectTemplate(id: template.id)
                showingContentEditor = true
              } label: {
                Text(template.name)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
              .buttonStyle(.borderless)
              .accessibilityIdentifier("settings-content-template-\(index + 1)")

              HStack(spacing: 20) {
                Button {
                  renaming = template
                  renameText = template.name
                } label: {
                  Image(systemName: "pencil")
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("settings-content-template-rename-\(index + 1)")

                Button(role: .destructive) {
                  deleting = template
                } label: {
                  Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("settings-content-template-delete-\(index + 1)")
              }
            }
          }

          Button("Add New Template") {
            copyFromID = environment.activeTemplateID
            newTemplateName = ""
            showingNewTemplate = true
          }
          .accessibilityIdentifier("settings-add-content-template")
        } header: {
          Text("Content Templates")
        } footer: {
          Text(
            "Radio selects the Output template. Tap the name to place and add content. "
              + "Pencil renames. Trash deletes."
          )
        }

        Section {
          ForEach(Array(environment.remoteTemplates.enumerated()), id: \.element.id) { index, template in
            HStack {
              Button {
                environment.selectRemoteTemplate(id: template.id)
              } label: {
                Image(
                  systemName: template.id == environment.activeRemoteTemplateID
                    ? "circle.inset.filled"
                    : "circle"
                )
              }
              .buttonStyle(.borderless)
              .padding(.trailing, 12)
              .accessibilityLabel("Select \(template.name)")
              .accessibilityIdentifier("settings-remote-template-select-\(index + 1)")

              Button {
                environment.selectRemoteTemplate(id: template.id)
                showingRemoteEditor = true
              } label: {
                Text(template.name)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
              .buttonStyle(.borderless)
              .accessibilityIdentifier("settings-remote-template-\(index + 1)")

              HStack(spacing: 20) {
                Button {
                  renamingRemote = template
                  renameRemoteText = template.name
                } label: {
                  Image(systemName: "pencil")
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("settings-remote-template-rename-\(index + 1)")

                Button(role: .destructive) {
                  deletingRemote = template
                } label: {
                  Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("settings-remote-template-delete-\(index + 1)")
              }
            }
          }

          Button("Add New Template") {
            copyRemoteFromID = environment.activeRemoteTemplateID
            newRemoteName = ""
            showingNewRemote = true
          }
          .accessibilityIdentifier("settings-add-remote-template")
        } header: {
          Text("Remote Control")
        } footer: {
          Text(
            "Radio selects the pad mapping. Tap the name to bind actions to button chords. "
              + "Pencil renames. Trash deletes."
          )
        }

        Section {
          Stepper(
            "Segment \(Int(draft.segmentSeconds))s",
            value: $draft.segmentSeconds,
            in: 2 ... 30,
            step: 1
          )
          .accessibilityIdentifier("settings-segment")
        } header: {
          Text("Camera archives")
        } footer: {
          Text("""
          Each camera is recorded exactly as it sends it — its own resolution, frame rate and \
          codec, copied to disk without re-encoding. There is nothing to choose here, and nothing \
          is ever downscaled. Segments end on the camera's own keyframes, so they run slightly \
          longer than the length below.
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
          Text("Programme master")
        } footer: {
          Text("""
          The programme master is a composite — cut, overlays and mixed audio — so it is the one \
          output that has to be encoded. These settings apply to it alone.
          """)
        }

        Section {
          HStack {
            TextField("rtmp://host:1935/live/key", text: $draft.streamURL)
              .keyboardType(.URL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .accessibilityIdentifier("settings-stream-url")
            if !draft.streamURL.isEmpty {
              Button {
                draft.streamURL = ""
              } label: {
                Image(systemName: "xmark.circle.fill")
                  .foregroundStyle(.secondary)
              }
              .buttonStyle(.borderless)
              .accessibilityIdentifier("settings-stream-url-clear")
              .accessibilityLabel("Clear stream URL")
            }
          }
        } header: {
          Text("Stream")
        } footer: {
          Text("RTMP URL the Stream button publishes the programme output to.")
        }

        Section("Retention") {
          Stepper(
            "Keep \(String(format: "%.1f", draft.retentionHours)) hours",
            value: $draft.retentionHours,
            in: 0.5 ... 24,
            step: 0.5
          )
          .accessibilityIdentifier("settings-retention")

          LabeledContent("Free space", value: Self.gigabytes(DirectorPaths.freeDiskBytes()))
            .accessibilityIdentifier("settings-free-space")
        }

        Section {
          Text("""
          Recording to external storage is not supported. GS Director writes to the iPad's \
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

        Section("Diagnostics") {
          Toggle("Telemetry overlay", isOn: $draft.showDebugHUD)
            .accessibilityIdentifier("settings-debug-hud")
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .accessibilityIdentifier("settings-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            draft.replaySlowMotionRate = AppConfig.clampedReplaySlowMotionRate(
              draft.replaySlowMotionRate / 100
            )
            environment.update(config: draft)
            dismiss()
          }
          .accessibilityIdentifier("settings-save")
        }
      }
    }
    .sheet(isPresented: $showingContentEditor) {
      ContentEditorView()
        .environment(environment)
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
        .presentationContentInteraction(.scrolls)
        .presentationSizing(.page)
    }
    .sheet(isPresented: $showingRemoteEditor) {
      RemoteControlEditorView()
        .environment(environment)
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
        .presentationContentInteraction(.scrolls)
        .presentationSizing(.page)
    }
    .sheet(isPresented: $showingNewRemote) {
      NewTemplateSheet(
        templates: environment.remoteTemplates.map {
          OverlayTemplate(id: $0.id, name: $0.name)
        },
        copyFromID: $copyRemoteFromID,
        name: $newRemoteName,
        onCreate: { sourceID in
          let created: UUID?
          if let sourceID {
            created = environment.duplicateRemoteTemplate(from: sourceID, name: newRemoteName)
          } else {
            created = environment.createRemoteTemplate(name: newRemoteName)
          }
          if created != nil {
            showingNewRemote = false
            showingRemoteEditor = true
          }
        }
      )
    }
    .sheet(isPresented: $showingNewTemplate) {
      NewTemplateSheet(
        templates: environment.templates,
        copyFromID: $copyFromID,
        name: $newTemplateName,
        onCreate: { sourceID in
          let created: UUID?
          if let sourceID {
            created = environment.duplicateTemplate(from: sourceID, name: newTemplateName)
          } else {
            created = environment.createTemplate(name: newTemplateName)
          }
          if created != nil {
            showingNewTemplate = false
            showingContentEditor = true
          }
        }
      )
    }
    .alert(
      "Rename template",
      isPresented: Binding(
        get: { renaming != nil },
        set: { if !$0 { renaming = nil } }
      )
    ) {
      TextField("Name", text: $renameText)
        .accessibilityIdentifier("settings-content-template-rename-field")
      Button("Save") {
        if let renaming {
          environment.renameTemplate(id: renaming.id, name: renameText)
        }
        renaming = nil
      }
      .accessibilityIdentifier("settings-content-template-rename-save")
      Button("Cancel", role: .cancel) { renaming = nil }
    }
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
      "Rename remote template",
      isPresented: Binding(
        get: { renamingRemote != nil },
        set: { if !$0 { renamingRemote = nil } }
      )
    ) {
      TextField("Name", text: $renameRemoteText)
        .accessibilityIdentifier("settings-remote-template-rename-field")
      Button("Save") {
        if let renamingRemote {
          environment.renameRemoteTemplate(id: renamingRemote.id, name: renameRemoteText)
        }
        renamingRemote = nil
      }
      .accessibilityIdentifier("settings-remote-template-rename-save")
      Button("Cancel", role: .cancel) { renamingRemote = nil }
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
    .onAppear {
      draft = environment.persistedConfig
      draft.replaySlowMotionRate = environment.persistedConfig.replaySlowMotionRate * 100
      draft.useSimulatedCameras = environment.isUsingSimulatedCameras
      draft.showDebugHUD = environment.config.showDebugHUD
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
  let onCreate: (UUID?) -> Void
  @Environment(\.dismiss) private var dismiss
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
          TextField("Name", text: $name)
            .accessibilityIdentifier("settings-new-template-name")
        }
      }
      .navigationTitle("New template")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .accessibilityIdentifier("settings-new-template-cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            onCreate(source == .copy ? copyFromID : nil)
          }
          .disabled(
            name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || (source == .copy && copyFromID == nil)
          )
          .accessibilityIdentifier("settings-new-template-create")
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}

/// 0–100 percent of live speed, with a tick every 10 and a taller mark every 25.
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
