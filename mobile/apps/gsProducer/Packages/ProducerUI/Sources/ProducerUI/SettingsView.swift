import ProducerCore
import SwiftUI

public struct SettingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var draft = AppConfig.default

  public init() {}

  public var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("URL", text: $draft.scoreboardURL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("settings-scoreboard-url")
        } header: {
          Text("Scoreboard")
        } footer: {
          Text("Saved on this iPad when you hit Save. Test launches no longer overwrite it.")
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
          The programme master is a composite — cut, scorebug and mixed audio — so it is the one \
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

          LabeledContent("Free space", value: Self.gigabytes(ProducerPaths.freeDiskBytes()))
            .accessibilityIdentifier("settings-free-space")
        }

        Section {
          Text("""
          Recording to external storage is not supported. GS Producer writes to the iPad's \
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
        } header: {
          Text("Sources")
        } footer: {
          Text(
            "On: generated test patterns. Off: cameras on the network. "
              + "Takes effect when you Save — no rebuild."
          )
        }

        Section {
          TextField("Rate", value: $draft.replaySlowMotionRate, format: .number)
            .keyboardType(.decimalPad)
            .accessibilityIdentifier("settings-replay-slowmo")
        } header: {
          Text("Instant replay")
        } footer: {
          Text("Slow-motion buttons play at this rate. 0.5 is half speed. Values outside 0.1–1.0 are clamped.")
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
              draft.replaySlowMotionRate
            )
            environment.update(config: draft)
            dismiss()
          }
          .accessibilityIdentifier("settings-save")
        }
      }
    }
    .onAppear {
      draft = environment.persistedConfig
      draft.useSimulatedCameras = environment.isUsingSimulatedCameras
      draft.showDebugHUD = environment.config.showDebugHUD
    }
  }

  private static func gigabytes(_ bytes: Int64) -> String {
    String(format: "%.1f GB", Double(bytes) / 1_073_741_824)
  }
}
