import AVFoundation
import ProducerCore
import ProducerPipeline
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

/// One production tile: live video, program outline, scrub gesture, state chrome.
public struct TileView: View {
  @Environment(AppEnvironment.self) private var environment

  private let tileIndex: Int
  private let pipeline: SourcePipeline?
  private let telemetry: TileTelemetry

  @State private var dragOffsetSeconds: Double = 0
  @State private var dragHistorySeconds: Double = 0
  @State private var dragOriginOffset: Double = 0
  @State private var dragFarthestTranslation: Double = 0
  @State private var isDragging = false
  @State private var tileWidth: CGFloat = 600

  public init(tileIndex: Int, pipeline: SourcePipeline?, telemetry: TileTelemetry) {
    self.tileIndex = tileIndex
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

      VStack(alignment: .trailing, spacing: 6) {
        HStack(alignment: .top) {
          nameplate
          Spacer()
          if isRewinding {
            VStack(alignment: .trailing, spacing: 6) {
              offsetBadge
              returnToLiveButton
            }
          }
        }
        Spacer()
          .allowsHitTesting(false)
        if isRewinding {
          InstantReplayCaption(accessibilityIdentifier: "tile-\(tileIndex + 1)-instant-replay")
        }
        if pipeline != nil {
          ReplayHotkeyBar(
            tileIndex: tileIndex,
            accessibilityPrefix: "tile-\(tileIndex + 1)",
            slowMotionRate: environment.config.replaySlowMotionRate
          ) { seconds, rate in
            environment.startInstantReplay(tileIndex: tileIndex, seconds: seconds, rate: rate)
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
      environment.selectProgram(tileIndex: tileIndex)
    }
    .gesture(scrubGesture)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("tile-\(tileIndex + 1)")
    .accessibilityLabel(telemetry.displayName ?? "empty tile \(tileIndex + 1)")
    .accessibilityValue(telemetry.accessibilityValue)
  }

  private var isRewinding: Bool {
    telemetry.state == .replaying || telemetry.state == .scrubbing
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
        if !isDragging {
          guard environment.beginScrub(tileIndex: tileIndex) else { return }
          isDragging = true
          // Sampled once, because the live edge keeps advancing: re-reading it every frame would
          // shift the time a given finger position maps to while the finger is still on it.
          dragHistorySeconds = environment.availableHistorySeconds(tileIndex: tileIndex)
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
        environment.updateScrub(tileIndex: tileIndex, offsetSeconds: dragOffsetSeconds)
      }
      .onEnded { value in
        let lift = Double(value.translation.width)
        if !isDragging {
          guard abs(lift) >= 12 || abs(dragFarthestTranslation) >= 12 else { return }
          guard environment.beginScrub(tileIndex: tileIndex) else { return }
          dragHistorySeconds = environment.availableHistorySeconds(tileIndex: tileIndex)
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
        environment.endScrub(tileIndex: tileIndex, offsetSeconds: offset)
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
      if telemetry.isProgram {
        Text("OUT")
          .font(.system(size: 10, weight: .heavy, design: .rounded))
          .padding(.horizontal, 5)
          .padding(.vertical, 2)
          .background(Color.programGreen, in: RoundedRectangle(cornerRadius: 3))
          .foregroundStyle(.black)
      }
      Text(telemetry.displayName ?? "—")
        .font(.system(size: 13, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
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

  private var offsetBadge: some View {
    Text(String(format: "−%.1fs", abs(telemetry.offsetSeconds)))
      .font(.system(size: 12, weight: .bold, design: .monospaced))
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Color.replayAmber, in: Capsule())
      .foregroundStyle(.black)
      .accessibilityIdentifier("tile-\(tileIndex + 1)-offset")
  }

  private var returnToLiveButton: some View {
    Button {
      environment.returnToLive(tileIndex: tileIndex)
    } label: {
      Label("Return to live", systemImage: "forward.end.fill")
        .font(.system(size: 12, weight: .bold, design: .rounded))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Color.white.opacity(0.92), in: Capsule())
        .foregroundStyle(.black)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("return-to-live-\(tileIndex + 1)")
  }
}

extension Color {
  static let programGreen = Color(red: 0.18, green: 0.86, blue: 0.42)
  static let recordRed = Color(red: 0.95, green: 0.24, blue: 0.28)
  static let replayAmber = Color(red: 0.99, green: 0.76, blue: 0.24)
  static let deckBackground = Color(red: 0.043, green: 0.047, blue: 0.055)
  static let deckPanel = Color(red: 0.09, green: 0.095, blue: 0.11)
}
