import DirectorCore
import DirectorPipeline
import SwiftUI

/// Drives the R2 measurement on demand: create encode sessions until one refuses, and report
/// the first failure with its code.
///
/// This exists because the concurrent-session ceiling is undocumented and cannot be derived.
/// `kVTCompressionPropertyKey_RecommendedParallelizationLimit` describes splitting one movie
/// across sessions for offline transcode, not a realtime ceiling, so it cannot answer R2.
public struct PerfHarnessView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var maximumSessions = 8

  public init() {}

  public var body: some View {
    NavigationStack {
      Form {
        Section("Encode session ceiling (R2)") {
          Stepper("Probe up to \(maximumSessions)", value: $maximumSessions, in: 1 ... 16)
            .accessibilityIdentifier("perf-session-count")

          Button("Run probe") {
            environment.runEncodeProbe(upTo: maximumSessions)
          }
          .accessibilityIdentifier("perf-run-probe")

          if let result = environment.probeResult {
            LabeledContent("Created", value: "\(result.created) / \(result.requested)")
              .accessibilityIdentifier("perf-created")
            LabeledContent("First failure", value: result.firstFailureCode.map(String.init) ?? "none")
              .accessibilityIdentifier("perf-failure-code")
            LabeledContent("Elapsed", value: "\(result.elapsedSeconds) s")
          }
        }

        Section("Live pipeline") {
          LabeledContent("Encode sessions", value: "\(environment.snapshot.sessions.encodeSessions)")
            .accessibilityIdentifier("perf-encode-sessions")
          LabeledContent("Decode sessions", value: "\(environment.snapshot.sessions.decodeSessions)")
            .accessibilityIdentifier("perf-decode-sessions")
          LabeledContent("Conversion", value: "\(environment.snapshot.converter.averageMilliseconds) ms/frame")
            .accessibilityIdentifier("perf-convert-ms")
          LabeledContent("Thermal state", value: environment.snapshot.thermalState)
            .accessibilityIdentifier("perf-thermal")
        }

        Section {
          LabeledContent("Current") {
            Text("\(Int(environment.snapshot.displayLatencyMilliseconds.rounded())) ms")
          }
          .accessibilityIdentifier("perf-display-latency")

          Toggle(
            "Cap display latency",
            isOn: Binding(
              get: { environment.config.displayLatencyCapEnabled },
              set: { environment.setDisplayLatencyCap(enabled: $0) }
            )
          )
          .accessibilityIdentifier("perf-display-latency-cap-enabled")

          if environment.config.displayLatencyCapEnabled {
            DisplayLatencyCapSlider(
              milliseconds: environment.config.displayLatencyCapMilliseconds,
              onChange: { environment.setDisplayLatencyCapMilliseconds($0) }
            )
          }
        } header: {
          Text("Display latency")
        } footer: {
          Text(
            environment.config.displayLatencyCapEnabled
              ? "The preview will not hold more than the cap. The engine may choose less."
              : "Unbounded: the engine sizes the delay to cover each camera's keyframe burst."
          )
        }

        Section("Per source") {
          ForEach(environment.snapshot.tiles.filter { $0.sourceID != nil }, id: \.index) { tile in
            VStack(alignment: .leading, spacing: 3) {
              Text(tile.displayName ?? "—").font(.headline)
              Text("""
              received \(tile.receivedFrames) · archived \(tile.archivedFrames) · \
              dropped \(tile.droppedFrames) · \(tile.framesPerSecond, specifier: "%.1f") fps
              """)
              .font(.system(size: 12, design: .monospaced))
              .foregroundStyle(.secondary)
              Text(tile.isArchiving ? "archiving \(tile.archiveHeight)p, camera's own stream" : "not archiving")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("perf-source-\(tile.index + 1)")
          }
        }
      }
      .navigationTitle("Performance")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        ModalActionFooter(
          primaryTitle: "DONE",
          primaryIdentifier: "perf-done",
          action: { dismiss() }
        )
      }
    }
  }
}

/// 10 ms to 2 s, labelled in milliseconds, with a tick every 100 ms and a taller mark every 500.
private struct DisplayLatencyCapSlider: View {
  var milliseconds: Double
  var onChange: (Double) -> Void

  private static let range = AppConfig.displayLatencyCapMinimumMilliseconds
    ... AppConfig.displayLatencyCapMaximumMilliseconds

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Maximum \(Int(milliseconds.rounded())) ms")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("perf-display-latency-cap-value")

      VStack(spacing: 4) {
        Slider(
          value: Binding(
            get: { milliseconds },
            set: { onChange($0) }
          ),
          in: Self.range,
          step: 10
        )
        .accessibilityIdentifier("perf-display-latency-cap")

        GeometryReader { geo in
          let span = Self.range.upperBound - Self.range.lowerBound
          ZStack(alignment: .bottomLeading) {
            ForEach(ticks, id: \.self) { tick in
              let x = (tick - Self.range.lowerBound) / span * geo.size.width
              Rectangle()
                .fill(Color.secondary.opacity(isMajor(tick) ? 0.75 : 0.35))
                .frame(width: 1, height: isMajor(tick) ? 12 : 6)
                .offset(x: x)
            }
          }
        }
        .frame(height: 12)
        .padding(.horizontal, 4)

        HStack {
          Text("\(Int(Self.range.lowerBound))")
          Spacer()
          Text("\(Int(Self.range.upperBound)) ms")
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
      }
    }
  }

  private var ticks: [Double] {
    Array(stride(from: 100, through: Self.range.upperBound, by: 100)) + [Self.range.lowerBound]
  }

  private func isMajor(_ tick: Double) -> Bool {
    tick == Self.range.lowerBound || tick == Self.range.upperBound || tick.truncatingRemainder(dividingBy: 500) == 0
  }
}
