import DirectorPipeline
import SwiftUI

/// The observability contract from plan §6.6, rendered.
///
/// Tile content is layer-backed and invisible to accessibility, so without this a Maestro flow
/// could only assert that the app launched. Every label is separately identified and carries a
/// `key=value` string, because `assertVisible` matches text and a single blob of status would
/// make every assertion ambiguous.
///
/// Only shown under `uiTest` (D7).
public struct DebugHUD: View {
  private let snapshot: TelemetrySnapshot

  public init(snapshot: TelemetrySnapshot) {
    self.snapshot = snapshot
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 10) {
        label("hud-profile", "profile=\(snapshot.sourceProfile)")
        label("hud-program-source", "output=\(snapshot.programTile.map { String($0 + 1) } ?? "none")")
        label("hud-thermal-state", "thermal=\(snapshot.thermalState)")
        label("hud-source-available", "live=\(snapshot.sourceAvailable ? "1" : "0")")
        label("hud-disc", "disc=\(snapshot.discoveredSourceCount)")
        if !snapshot.discoveryStatus.isEmpty {
          label("hud-discovery-status", snapshot.discoveryStatus)
        }
      }
      HStack(spacing: 10) {
        label("hud-recording", "rec=\(snapshot.dvr.isRecording ? "1" : "0")")
        label("hud-dvr-duration", "dur=\(recordingSeconds)")
        label("hud-dvr-segments", "seg=\(snapshot.dvr.segmentCount)")
        label("hud-dvr-bytes", "bytes=\(snapshot.dvr.byteCount)")
        label("hud-proxy-stills", "proxy=\(snapshot.dvr.proxyStills)")
        label("hud-dropped-frames", "drop=\(totalDropped)")
        label("hud-flush", "flush=\(snapshot.dvr.lastFlushSeconds)")
        label("hud-program-bytes", "progbytes=\(programBytes)")
      }
      HStack(spacing: 10) {
        label("hud-encode-sessions", "enc=\(snapshot.sessions.encodeSessions)")
        label("hud-decode-sessions", "dec=\(snapshot.sessions.decodeSessions)")
        label("hud-encode-failures", "encfail=\(snapshot.sessions.encodeFailures)")
        label("hud-convert-ms", "convms=\(snapshot.converter.averageMilliseconds)")
        label("hud-clock", "clock=\(Int(snapshot.clockSeconds))")
        label("hud-replay-latency", "replayms=\(replayLatency)")
        label("hud-replay-error", "replayerr=\(snapshot.lastReplayError.isEmpty ? "ok" : "fail")")
        label("hud-memory", "mem=\(snapshot.physFootprintMB)")
        label("hud-avail-memory", "avail=\(snapshot.availableMemoryMB)")
      }
      HStack(spacing: 10) {
        label("hud-overlay", "overlay=\(snapshot.overlay.isEmpty ? "off" : snapshot.overlay)")
        label("hud-composed", "composed=\(snapshot.composedFrames)")
        label("hud-audio-mix", "mix=\(snapshot.audioMixContributors)")
        label("hud-audio-mix-seconds", "mixs=\(snapshot.audioMixSeconds)")
        // Loss belongs next to the mix rather than per tile: a link losing packets loses them for
        // every camera at once, which is the reading that tells the operator it is the network.
        label("hud-packets-lost", "loss=\(totalPacketsLost)")
        if let status = sourceStatus {
          label("hud-source-status", "src=\(status)")
        }
        if let cname = programCNAME {
          label("hud-cname", "cname=\(cname)")
        }
      }
      ForEach(snapshot.tiles, id: \.index) { tile in
        label("hud-tile-\(tile.index + 1)-state", tile.accessibilityValue)
      }
    }
    .font(.system(size: 11, weight: .medium, design: .monospaced))
    .foregroundStyle(.white)
    .padding(8)
    .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 6))
    // `.contain` is load-bearing: without it the container identifier propagates down and replaces
    // every label's own identifier, so the whole HUD reports as `debug-hud` and no `hud-*` selector
    // can ever match.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("debug-hud")
  }

  private var totalDropped: UInt64 {
    snapshot.tiles.reduce(0) { $0 + $1.droppedFrames }
  }

  private var totalPacketsLost: UInt64 {
    snapshot.tiles.reduce(0) { $0 + $1.packetsLost }
  }

  /// The first tile with something to say. A camera that is black for a knowable reason should say
  /// so; several failing at once are almost always failing for the same reason.
  private var sourceStatus: String? {
    snapshot.tiles.first { !$0.sourceStatus.isEmpty }?.sourceStatus
  }

  /// The identifier the camera currently on air is presenting. Only the programme tile, because the
  /// HUD has one line for it and the question it answers — "is the right camera on air?" — is only
  /// ever asked about that tile.
  private var programCNAME: String? {
    guard let index = snapshot.programTile else { return nil }
    let cname = snapshot.tiles.first { $0.index == index }?.cname
    return (cname?.isEmpty == false) ? cname : nil
  }

  /// R6, from the most recent replay on any tile. Only one tile replays at a time, so taking the
  /// maximum reports that replay rather than mixing several.
  private var replayLatency: Int {
    Int(snapshot.tiles.map(\.replayLatencyMilliseconds).max() ?? 0)
  }

  /// How long the *current* recording has been running. `segmentCount` accumulates across
  /// recordings, so it cannot tell a flow how much history is scrubbable right now.
  private var recordingSeconds: Int {
    guard let startedAt = snapshot.dvr.recordingStartedAt else { return 0 }
    return max(0, Int(snapshot.clockSeconds - startedAt))
  }

  /// Size of the last program master file. The program encoder can fail without stopping the
  /// recording — it is a degradation, not an abort — so "recording succeeded" says nothing about
  /// whether a program file exists.
  private var programBytes: String {
    snapshot.dvr.programOutput.split(separator: " ").last.map(String.init) ?? "0"
  }

  private func label(_ identifier: String, _ text: String) -> some View {
    Text(text)
      .accessibilityIdentifier(identifier)
      .accessibilityLabel(text)
  }
}
