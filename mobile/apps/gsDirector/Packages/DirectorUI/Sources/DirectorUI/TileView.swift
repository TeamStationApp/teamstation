import AVFoundation
import CameramanControlUI
import CameramanCore
import DirectorCore
import DirectorPipeline
import SwiftUI
import UIKit

/// UIKit host for one tile's `AVSampleBufferDisplayLayer` (D3).
public struct TileVideoView: UIViewRepresentable {
  private let renderer: TileRenderer

  public init(renderer: TileRenderer) {
    self.renderer = renderer
  }

  public func makeUIView(context: Context) -> SampleBufferView {
    let view = SampleBufferView()
    renderer.attach(layer: view.displayLayer)
    return view
  }

  public func updateUIView(_ uiView: SampleBufferView, context: Context) {
    renderer.attach(layer: uiView.displayLayer)
  }

  public static func dismantleUIView(_ uiView: SampleBufferView, coordinator: ()) {
    // Flush this view's layer only. Do not `attach(nil)` — SwiftUI can dismantle the old
    // host after the replacement has already attached, which would leave Output enqueueing
    // into nowhere (black programme tile, cuts still update the nameplate).
    uiView.displayLayer.sampleBufferRenderer.flush(removingDisplayedImage: false)
  }

  public final class SampleBufferView: UIView {
    override public class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }

    var displayLayer: AVSampleBufferDisplayLayer {
      layer as! AVSampleBufferDisplayLayer
    }

    override init(frame: CGRect) {
      super.init(frame: frame)
      backgroundColor = .black
      displayLayer.videoGravity = .resizeAspect
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) is unavailable")
    }
  }
}

/// A second monitor on the same renderer, used by the camera picker. Detaches on teardown so
/// it cannot leave a dangling layer after the sheet closes.
struct CameraPreviewView: UIViewRepresentable {
  let renderer: TileRenderer

  func makeCoordinator() -> Coordinator { Coordinator(renderer: renderer) }

  func makeUIView(context: Context) -> TileVideoView.SampleBufferView {
    let view = TileVideoView.SampleBufferView()
    context.coordinator.renderer.attachPreview(view.displayLayer)
    return view
  }

  func updateUIView(_ uiView: TileVideoView.SampleBufferView, context: Context) {
    context.coordinator.renderer.attachPreview(uiView.displayLayer)
  }

  static func dismantleUIView(
    _ uiView: TileVideoView.SampleBufferView,
    coordinator: Coordinator
  ) {
    coordinator.renderer.detachPreview(uiView.displayLayer)
  }

  final class Coordinator {
    let renderer: TileRenderer
    init(renderer: TileRenderer) { self.renderer = renderer }
  }
}

/// One director tile: live video, program outline, scrub gesture, state chrome.
public struct TileView: View {
  @Environment(AppEnvironment.self) private var environment

  private let sourceIndex: Int
  private let pipeline: SourcePipeline?
  private let telemetry: TileTelemetry

  @State private var dragOffsetSeconds: Double = 0
  @State private var dragHistorySeconds: Double = 0
  @State private var dragOriginOffset: Double = 0
  @State private var dragFarthestTranslation: Double = 0
  @State private var isDragging = false
  @State private var tileWidth: CGFloat = 600

  public init(sourceIndex: Int, pipeline: SourcePipeline?, telemetry: TileTelemetry) {
    self.sourceIndex = sourceIndex
    self.pipeline = pipeline
    self.telemetry = telemetry
  }

  public var body: some View {
    ZStack {
      Rectangle().fill(Color.black)

      if let pipeline {
        TileVideoView(renderer: pipeline.renderer)
          .allowsHitTesting(false)
      } else {
        VStack(spacing: 6) {
          Image(systemName: "video.slash")
            .font(.system(size: 28, weight: .light))
          Text("No source")
            .font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(.white.opacity(0.32))
      }

      if isRewinding {
        InstantReplayCaption(accessibilityIdentifier: "source-\(sourceIndex + 1)-instant-replay")
          .padding(10)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
          .allowsHitTesting(false)
      }

      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .center, spacing: 6) {
          if isRewinding {
            returnToLiveButton
            if !stacksRewindChrome {
              offsetBadge
            }
          }
          if !isRewinding || !stacksRewindChrome {
            nameplate
          }
          Spacer()
          if pipeline != nil, !isRewinding {
            lossPill
          }
          if telemetry.hasCameraControl {
            cameraStatusPills
            cameraMenuButton
          }
        }
        if isRewinding, stacksRewindChrome {
          offsetBadge
            .padding(.top, 6)
        }
        Spacer()
          .allowsHitTesting(false)
        if pipeline != nil {
          ReplayHotkeyBar(
            sourceIndex: sourceIndex,
            accessibilityPrefix: "source-\(sourceIndex + 1)",
            slowMotionRate: environment.config.replaySlowMotionRate
          ) { seconds, rate in
            environment.startInstantReplay(sourceIndex: sourceIndex, seconds: seconds, rate: rate)
          }
        }
      }
      .padding(10)
    }
    .clipShape(RoundedRectangle(cornerRadius: 4))
    .overlay(
      RoundedRectangle(cornerRadius: 4)
        .strokeBorder(
          telemetry.isProgram ? Color.programGreen : Color.white.opacity(0.10),
          lineWidth: telemetry.isProgram ? 3 : 1
        )
    )
    .contentShape(Rectangle())
    .background {
      GeometryReader { geo in
        Color.clear
          .onAppear { tileWidth = geo.size.width }
          .onChange(of: geo.size.width) { _, width in tileWidth = width }
      }
    }
    .onTapGesture {
      guard pipeline != nil else { return }
      guard environment.draggingSourceIndex == nil else { return }
      guard ProcessInfo.processInfo.systemUptime >= environment.ignoreProgramTapUntil else { return }
      environment.selectProgram(sourceIndex: sourceIndex)
    }
    .gesture(scrubGesture)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("source-\(sourceIndex + 1)")
    .accessibilityLabel("source \(sourceIndex + 1): \(telemetry.displayName ?? "—")")
    .accessibilityValue(telemetry.accessibilityValue)
  }

  private var isRewinding: Bool {
    telemetry.state == .replaying || telemetry.state == .scrubbing
  }

  /// A Cameraman tile already spends the right-hand end of its top row on thermal, battery and the
  /// menu. Adding Return to Live, the offset and the nameplate to the left of that overruns the
  /// tile and the row collapses into itself. On those tiles the nameplate gives way to Return to
  /// Live and the offset moves onto its own line underneath, both left-justified.
  private var stacksRewindChrome: Bool {
    telemetry.hasCameraControl
  }

  /// One small-tile width is 60 seconds at a constant rate. Extra travel keeps that rate;
  /// the only clamp is available history.
  ///
  /// The origin is the playhead at finger-down, not live. A second swipe therefore continues
  /// from where the tile is already playing, instead of seeking as if the tape were at the end.
  private var scrubGesture: some Gesture {
    DragGesture(minimumDistance: 12)
      .onChanged { value in
        guard pipeline != nil else { return }
        guard environment.draggingSourceIndex == nil else { return }
        if !isDragging {
          guard environment.beginScrub(sourceIndex: sourceIndex) else { return }
          isDragging = true
          // Sampled once, because the live edge keeps advancing: re-reading it every frame would
          // shift the time a given finger position maps to while the finger is still on it.
          dragHistorySeconds = environment.availableHistorySeconds(sourceIndex: sourceIndex)
          dragOriginOffset = telemetry.offsetSeconds
          dragFarthestTranslation = 0
        }
        let translation = Double(value.translation.width)
        if abs(translation) >= abs(dragFarthestTranslation) {
          dragFarthestTranslation = translation
        }
        dragOffsetSeconds = ScrubMapping.offsetSeconds(
          translation: translation,
          tileWidth: mappedTileWidth,
          historySeconds: dragHistorySeconds,
          playheadOffset: dragOriginOffset
        )
        environment.updateScrub(sourceIndex: sourceIndex, offsetSeconds: dragOffsetSeconds)
      }
      .onEnded { value in
        guard environment.draggingSourceIndex == nil else { return }
        let lift = Double(value.translation.width)
        if !isDragging {
          guard abs(lift) >= 12 || abs(dragFarthestTranslation) >= 12 else { return }
          guard environment.beginScrub(sourceIndex: sourceIndex) else { return }
          dragHistorySeconds = environment.availableHistorySeconds(sourceIndex: sourceIndex)
          dragOriginOffset = telemetry.offsetSeconds
        }
        isDragging = false
        let translation = ScrubMapping.endTranslation(
          lift: lift,
          farthest: dragFarthestTranslation
        )
        let offset = ScrubMapping.offsetSeconds(
          translation: translation,
          tileWidth: mappedTileWidth,
          historySeconds: dragHistorySeconds,
          playheadOffset: dragOriginOffset
        )
        environment.endScrub(sourceIndex: sourceIndex, offsetSeconds: offset)
        dragOffsetSeconds = 0
        dragOriginOffset = 0
        dragFarthestTranslation = 0
      }
  }

  private var mappedTileWidth: Double {
    environment.smallTileWidth > 1 ? environment.smallTileWidth : Double(tileWidth)
  }

  private var nameplate: some View {
    HStack(spacing: 6) {
      // No on-air badge here: the green outline already says which tile is programme, and the
      // header of a narrow tile has no room to say it twice.
      //
      // The status pills to the right of this hold their width now, so on a narrow tile the
      // squeeze lands here instead. Truncate the name rather than wrap the header onto two lines.
      // The accessibility label on the tile still says "source N", which reads better aloud.
      Text("\(sourceIndex + 1): \(telemetry.displayName ?? "—")")
        .font(.system(size: 13, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
        .lineLimit(1)
        .truncationMode(.tail)
        .accessibilityIdentifier("source-\(sourceIndex + 1)-nameplate")
      if telemetry.isArchiving {
        Circle()
          .fill(Color.recordRed)
          .frame(width: 7, height: 7)
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(.black.opacity(0.45), in: Capsule())
  }

  /// What the link lost in the last second, as a bare number on the nameplate's grey. Shown even
  /// at zero, because a zero that is there says the link is measured and clean, where a pill that
  /// hid at zero would leave "clean" and "not shown" looking the same. A tile that is not
  /// delivering shows an em dash instead — see `TileTelemetry.lossPerSecondLabel` for why a dead
  /// link would otherwise read zero like a clean one. Hidden in rewind so that chrome — which
  /// already overruns a Cameraman tile — keeps the room. On an NDI tile the number is the SDK's
  /// dropped frames; see `TileTelemetry.packetsLostPerSecond`.
  private var lossPill: some View {
    StatPill(
      text: telemetry.lossPerSecondLabel,
      identifier: "source-\(sourceIndex + 1)-loss",
      label: "Lost per second",
      value: telemetry.lossPerSecondLabel
    )
  }

  /// The phone's own thermal and battery, one header row tall, in the corner where the phone
  /// draws them. Untappable; a tap here still cuts the tile to programme.
  @ViewBuilder
  private var cameraStatusPills: some View {
    if let thermal = telemetry.cameraThermal {
      ThermalBadge(
        level: ThermalBadgeLevel(telemetryName: thermal),
        animate: false,
        identifier: "source-\(sourceIndex + 1)-camera-thermal",
        passesTouches: false,
        style: .compact
      )
    }
    if let percent = telemetry.cameraBatteryPercent {
      BatteryBadge(
        status: BatteryStatus(percent: percent, isCharging: telemetry.cameraBatteryCharging),
        style: .compact,
        identifier: "source-\(sourceIndex + 1)-camera-battery"
      )
    }
  }

  /// Three vertical dots. Swallows its tap so it neither cuts the tile to programme nor starts
  /// a scrub.
  private var cameraMenuButton: some View {
    Image(systemName: "ellipsis")
      .rotationEffect(.degrees(90))
      .font(.system(size: 16, weight: .bold))
      .foregroundStyle(.white)
      .frame(width: 36, height: 36)
      .background(.black.opacity(0.45), in: Capsule())
      .contentShape(Capsule())
      .highPriorityGesture(
        TapGesture().onEnded {
          environment.openCameraControl(sourceIndex: sourceIndex)
        }
      )
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("source-\(sourceIndex + 1)-camera-menu")
      .accessibilityLabel("Camera controls")
  }

  private var offsetBadge: some View {
    Text(String(format: "−%.1fs", abs(telemetry.offsetSeconds)))
      .font(.system(size: 12, weight: .bold, design: .monospaced))
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Color.replayAmber, in: Capsule())
      .foregroundStyle(.black)
      .accessibilityIdentifier("source-\(sourceIndex + 1)-offset")
  }

  private var returnToLiveButton: some View {
    Button {
      environment.returnToLive(sourceIndex: sourceIndex)
    } label: {
      Label("Return to Live", systemImage: "forward.end.fill")
        .font(.system(size: 12, weight: .bold, design: .rounded))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Color.white.opacity(0.92), in: Capsule())
        .foregroundStyle(.black)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("return-to-live-\(sourceIndex + 1)")
  }
}

extension Color {
  static let programGreen = Color(red: 0.18, green: 0.86, blue: 0.42)
  static let recordRed = Color(red: 0.95, green: 0.24, blue: 0.28)
  static let replayAmber = Color(red: 0.99, green: 0.76, blue: 0.24)
  static let deckBackground = Color(red: 0.043, green: 0.047, blue: 0.055)
  static let deckPanel = Color(red: 0.09, green: 0.095, blue: 0.11)
  static let sourceBlue = Color(red: 0.18, green: 0.48, blue: 0.95)
}
