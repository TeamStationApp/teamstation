import DirectorCore
import SwiftUI

public struct SettingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var draft = AppConfig.default
  @State private var showingContentEditor = false
  @State private var showingClearCameraMemory = false

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
          Button("Add Content") {
            showingContentEditor = true
          }
          .accessibilityIdentifier("settings-add-content")
        } header: {
          Text("Output overlays")
        } footer: {
          Text("Place a web view or an image on Output. Drag to position. Long-press to edit.")
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
