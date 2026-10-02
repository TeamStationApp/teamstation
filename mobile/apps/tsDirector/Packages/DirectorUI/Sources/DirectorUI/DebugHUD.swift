import DirectorPipeline
import SwiftUI
import UIKit

/// Identifier + text pairs the HUD shows. Split from the view so a unit test can lock the
/// Maestro selectors without spinning up SwiftUI, and so the on-screen host can be UIKit.
///
/// SwiftUI `Text` updated on a display link grew an unbounded `DisplayList` (foreground abort
/// after a multi-hour soak: `swift_abortAllocationFailure` in `DisplayList.append`). UILabel
/// updates do not participate in that path.
public struct DebugHUDLine: Equatable, Sendable {
  public var id: String
  public var text: String

  public init(id: String, text: String) {
    self.id = id
    self.text = text
  }
}

public enum DebugHUDLines {
  /// Rows match the old SwiftUI `HStack` grouping so the overlay still reads as a compact HUD.
  public static func make(_ snapshot: TelemetrySnapshot) -> [[DebugHUDLine]] {
    var rows: [[DebugHUDLine]] = []

    var discovery: [DebugHUDLine] = [
      .init(id: "hud-profile", text: "profile=\(snapshot.sourceProfile)"),
      .init(id: "hud-program-source", text: "output=\(snapshot.programSource.map { String($0 + 1) } ?? "none")"),
      .init(id: "hud-thermal-state", text: "thermal=\(snapshot.thermalState)"),
      .init(id: "hud-source-available", text: "live=\(snapshot.sourceAvailable ? "1" : "0")"),
      .init(id: "hud-disc", text: "disc=\(snapshot.discoveredSourceCount)")
    ]
    if !snapshot.discoveryStatus.isEmpty {
      discovery.append(.init(id: "hud-discovery-status", text: snapshot.discoveryStatus))
    }
    rows.append(discovery)

    rows.append([
      .init(id: "hud-recording", text: "rec=\(snapshot.dvr.isRecording ? "1" : "0")"),
      .init(id: "hud-dvr-duration", text: "dur=\(snapshot.recordingSeconds)"),
      .init(id: "hud-dvr-segments", text: "seg=\(snapshot.dvr.segmentCount)"),
      .init(id: "hud-dvr-bytes", text: "bytes=\(snapshot.dvr.byteCount)"),
      .init(id: "hud-proxy-stills", text: "proxy=\(snapshot.dvr.proxyStills)"),
      .init(id: "hud-dropped-frames", text: "drop=\(totalDropped(snapshot))"),
      .init(id: "hud-flush", text: "flush=\(snapshot.dvr.lastFlushSeconds)"),
      .init(id: "hud-program-bytes", text: "progbytes=\(programBytes(snapshot))")
    ])

    // Whether this take was picked up rather than started, how long the app was away when it was,
    // whether the stream came back with it, and which camera is on air. A flow asserting that a
    // resume worked has to be able to read all four without opening the database.
    rows.append([
      .init(id: "hud-resumed", text: "resumed=\(snapshot.dvr.resumeCount)"),
      .init(id: "hud-downtime", text: "down=\(Int(snapshot.dvr.lastDowntimeSeconds.rounded()))"),
      .init(id: "hud-streaming", text: "stream=\(snapshot.isStreaming ? "1" : "0")"),
      .init(id: "hud-resumed-stream", text: "resumestream=\(snapshot.dvr.resumedStream ? "1" : "0")"),
      .init(id: "hud-program-source", text: "prog=\(snapshot.programSource.map(String.init) ?? "-")")
    ])

    rows.append([
      .init(id: "hud-encode-sessions", text: "enc=\(snapshot.sessions.encodeSessions)"),
      .init(id: "hud-decode-sessions", text: "dec=\(snapshot.sessions.decodeSessions)"),
      .init(id: "hud-encode-failures", text: "encfail=\(snapshot.sessions.encodeFailures)"),
      .init(id: "hud-convert-ms", text: "convms=\(snapshot.converter.averageMilliseconds)"),
      .init(id: "hud-clock", text: "clock=\(Int(snapshot.clockSeconds))"),
      .init(id: "hud-replay-latency", text: "replayms=\(replayLatency(snapshot))"),
      .init(id: "hud-replay-error", text: "replayerr=\(snapshot.lastReplayError.isEmpty ? "ok" : "fail")"),
      .init(id: "hud-memory", text: "mem=\(snapshot.physFootprintMB)"),
      .init(id: "hud-resident", text: "rss=\(snapshot.residentSizeMB)"),
      .init(id: "hud-avail-memory", text: "avail=\(snapshot.availableMemoryMB)"),
      .init(
        id: "hud-stream-keyframe-age",
        text: String(format: "kfage=%.1f", snapshot.streamKeyframeAgeSeconds)
      ),
      .init(id: "hud-stream-keyframe-count", text: "kfn=\(snapshot.streamKeyframeCount)"),
      .init(id: "hud-stream-pending-encodes", text: "pend=\(snapshot.streamPendingEncodes)"),
      .init(
        id: "hud-stream-callback-age",
        text: String(format: "cbage=%.1f", snapshot.streamEncodeCallbackAgeSeconds)
      ),
      .init(
        id: "hud-program-frame-age",
        text: String(format: "pfage=%.1f", snapshot.programFrameAgeSeconds)
      ),
      .init(id: "hud-stream-idle-keyframes", text: "idlekf=\(snapshot.streamIdleKeyframeCount)"),
      .init(id: "hud-stream-encoder-resets", text: "encreset=\(snapshot.streamEncoderResetCount)")
    ])

    // The stream's bitrate controller: codec, the rate now inside the operator's range, the last
    // decision and the queue and delivery it was made on, how often it has moved, and what the send
    // budget shed. A stream doing its job moves the first numbers and leaves the last at zero.
    let rate = snapshot.streamRate
    rows.append([
      .init(id: "hud-stream-codec", text: "scodec=\(rate.codec.isEmpty ? "-" : rate.codec)"),
      .init(id: "hud-stream-bitrate", text: String(format: "sbr=%.1f", Double(rate.bitrate) / 1_000_000)),
      .init(
        id: "hud-stream-range",
        text: String(format: "srange=%.1f-%.1f", Double(rate.low) / 1_000_000, Double(rate.high) / 1_000_000)
      ),
      .init(id: "hud-stream-decision", text: "sdec=\(rate.lastDecision.isEmpty ? "-" : rate.lastDecision)"),
      .init(id: "hud-stream-queue", text: "sq=\(rate.queueMilliseconds)"),
      .init(
        id: "hud-stream-delivery",
        text: String(format: "sdlv=%.1f", Double(rate.deliveryBitsPerSecond) / 1_000_000)
      ),
      .init(id: "hud-stream-decreases", text: "scut=\(rate.decreases)"),
      .init(id: "hud-stream-increases", text: "sup=\(rate.increases)"),
      .init(id: "hud-stream-dropped", text: "sdrop=\(snapshot.streamDroppedPackets)")
    ])

    var mix: [DebugHUDLine] = [
      .init(id: "hud-overlay", text: "overlay=\(snapshot.overlay.isEmpty ? "off" : snapshot.overlay)"),
      .init(id: "hud-composed", text: "composed=\(snapshot.composedFrames)"),
      .init(id: "hud-audio-mix", text: "mix=\(snapshot.audioMixContributors)"),
      .init(id: "hud-audio-mix-seconds", text: "mixs=\(snapshot.audioMixSeconds)"),
      .init(id: "hud-audio-mix-late", text: "mixlate=\(snapshot.audioMixLateBuffers)"),
      .init(id: "hud-audio-mix-future", text: "mixfut=\(snapshot.audioMixFutureBuffers)"),
      .init(id: "hud-audio-out", text: "aout=\(snapshot.programAudioPlaying ? "1" : "0")"),
      .init(id: "hud-bg-keep", text: "bgkeep=\(snapshot.keepAliveInBackground ? "1" : "0")"),
      .init(id: "hud-pip", text: "pip=\(snapshot.pictureInPictureActive ? "1" : "0")"),
      .init(id: "hud-packets-lost", text: "loss=\(totalPacketsLost(snapshot))")
    ]
    if let status = sourceStatus(snapshot) {
      mix.append(.init(id: "hud-source-status", text: "src=\(status)"))
    }
    if let cname = programCNAME(snapshot) {
      mix.append(.init(id: "hud-cname", text: "cname=\(cname)"))
    }
    rows.append(mix)

    for tile in snapshot.tiles {
      rows.append([
        .init(id: "hud-source-\(tile.index + 1)-state", text: tile.accessibilityValue)
      ])
    }
    return rows
  }

  private static func totalDropped(_ snapshot: TelemetrySnapshot) -> UInt64 {
    snapshot.tiles.reduce(0) { $0 + $1.droppedFrames }
  }

  private static func totalPacketsLost(_ snapshot: TelemetrySnapshot) -> UInt64 {
    snapshot.tiles.reduce(0) { $0 + $1.packetsLost }
  }

  private static func sourceStatus(_ snapshot: TelemetrySnapshot) -> String? {
    snapshot.tiles.first { !$0.sourceStatus.isEmpty }?.sourceStatus
  }

  private static func programCNAME(_ snapshot: TelemetrySnapshot) -> String? {
    let cname = snapshot.programTile?.cname
    return (cname?.isEmpty == false) ? cname : nil
  }

  private static func replayLatency(_ snapshot: TelemetrySnapshot) -> Int {
    Int(snapshot.tiles.map(\.replayLatencyMilliseconds).max() ?? 0)
  }



  private static func programBytes(_ snapshot: TelemetrySnapshot) -> String {
    snapshot.dvr.programOutput.split(separator: " ").last.map(String.init) ?? "0"
  }
}

/// The observability contract from plan §6.6, rendered.
///
/// Tile content is layer-backed and invisible to accessibility, so without this a Maestro flow
/// could only assert that the app launched. Every label is separately identified and carries a
/// `key=value` string, because `assertVisible` matches text and a single blob of status would
/// make every assertion ambiguous.
///
/// Only shown under `uiTest` (D7). Hosted in UIKit so 5 Hz telemetry cannot grow a SwiftUI
/// `DisplayList`.
public struct DebugHUD: View {
  private let snapshot: TelemetrySnapshot

  public init(snapshot: TelemetrySnapshot) {
    self.snapshot = snapshot
  }

  public var body: some View {
    DebugHUDRepresentable(snapshot: snapshot)
      .fixedSize(horizontal: false, vertical: true)
      .allowsHitTesting(false)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("debug-hud")
  }
}

private struct DebugHUDRepresentable: UIViewRepresentable {
  var snapshot: TelemetrySnapshot

  func makeUIView(context: Context) -> DebugHUDView {
    DebugHUDView()
  }

  func updateUIView(_ uiView: DebugHUDView, context: Context) {
    uiView.apply(DebugHUDLines.make(snapshot))
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: DebugHUDView, context: Context) -> CGSize {
    let width = proposal.width ?? 800
    return uiView.measuredSize(forWidth: width)
  }
}

/// Wrapping chip layout. A horizontal `UIStackView` compressed to height 0, which made Maestro
/// treat every `hud-*` label as not visible.
final class DebugHUDView: UIView {
  private let font = UIFont.monospacedSystemFont(ofSize: 11, weight: .medium)
  private var ordered: [UILabel] = []
  private var labels: [String: UILabel] = [:]
  private var fitted = CGSize(width: 800, height: 44)

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor.black.withAlphaComponent(0.72)
    layer.cornerRadius = 6
    clipsToBounds = true
    isAccessibilityElement = false
    accessibilityIdentifier = "debug-hud"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is unavailable")
  }

  func apply(_ rows: [[DebugHUDLine]]) {
    let lines = rows.flatMap { $0 }
    let ids = lines.map(\.id)
    if ids != ordered.map({ $0.accessibilityIdentifier ?? "" }) {
      rebuild(lines)
    } else {
      for line in lines {
        guard labels[line.id]?.text != line.text else { continue }
        labels[line.id]?.text = line.text
        labels[line.id]?.accessibilityLabel = line.text
      }
    }
    invalidateIntrinsicContentSize()
    setNeedsLayout()
  }

  func measuredSize(forWidth width: CGFloat) -> CGSize {
    layoutChips(in: max(width, 40))
    return fitted
  }

  override var intrinsicContentSize: CGSize { fitted }

  override func layoutSubviews() {
    super.layoutSubviews()
    layoutChips(in: bounds.width)
  }

  private func rebuild(_ lines: [DebugHUDLine]) {
    ordered.forEach { $0.removeFromSuperview() }
    ordered.removeAll()
    labels.removeAll()
    for line in lines {
      let label = UILabel()
      label.font = font
      label.textColor = .white
      label.text = line.text
      label.numberOfLines = 0
      label.lineBreakMode = .byWordWrapping
      label.isAccessibilityElement = true
      label.accessibilityIdentifier = line.id
      label.accessibilityLabel = line.text
      addSubview(label)
      ordered.append(label)
      labels[line.id] = label
    }
  }

  private func layoutChips(in width: CGFloat) {
    let inset: CGFloat = 8
    let gap: CGFloat = 10
    let rowGap: CGFloat = 2
    var x = inset
    var y = inset
    var rowHeight: CGFloat = 0
    let maxWidth = max(width - inset * 2, 40)
    for label in ordered {
      let size = label.sizeThatFits(CGSize(width: maxWidth, height: 24))
      let w = min(max(size.width, 8), maxWidth)
      let h = max(size.height, 14)
      if x > inset && x + w > width - inset {
        x = inset
        y += rowHeight + rowGap
        rowHeight = 0
      }
      label.frame = CGRect(x: x, y: y, width: w, height: h)
      x += w + gap
      rowHeight = max(rowHeight, h)
    }
    fitted = CGSize(width: width, height: y + rowHeight + inset)
  }
}
