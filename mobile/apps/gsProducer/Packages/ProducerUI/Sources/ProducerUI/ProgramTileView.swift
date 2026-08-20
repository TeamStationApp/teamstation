import ProducerPipeline
import SwiftUI

/// The merged 2×2 cell: what Output actually looks like, scorebug included.
///
/// It renders the composited frame rather than the source tile's, so the operator is watching the
/// same pixels the encoder is being handed. That distinction is the reason the tile exists — a
/// scorebug that is mispositioned, stale or missing is invisible in the source tiles, and until now
/// would only have shown up in the recorded file after the game.
public struct ProgramTileView: View {
  @Environment(AppEnvironment.self) private var environment

  private let renderer: TileRenderer
  private let snapshot: TelemetrySnapshot

  public init(renderer: TileRenderer, snapshot: TelemetrySnapshot) {
    self.renderer = renderer
    self.snapshot = snapshot
  }

  public var body: some View {
    ZStack {
      Rectangle().fill(Color.black)

      TileVideoView(renderer: renderer)
        .allowsHitTesting(false)

      VStack(alignment: .trailing, spacing: 6) {
        HStack(alignment: .top, spacing: 8) {
          nameplate
          Spacer()
          if snapshot.dvr.isRecording {
            Text("REC")
              .font(.system(size: 10, weight: .heavy, design: .rounded))
              .tracking(1)
              .padding(.horizontal, 6)
              .padding(.vertical, 3)
              .background(Color.recordRed, in: RoundedRectangle(cornerRadius: 3))
              .foregroundStyle(.white)
          }
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
          InstantReplayCaption(accessibilityIdentifier: "output-instant-replay")
        }
        if snapshot.programTile != nil {
          ReplayHotkeyBar(
            tileIndex: snapshot.programTile ?? 0,
            accessibilityPrefix: "output",
            slowMotionRate: environment.config.replaySlowMotionRate
          ) { seconds, rate in
            guard let tileIndex = snapshot.programTile else { return }
            environment.startInstantReplay(tileIndex: tileIndex, seconds: seconds, rate: rate)
          }
        }
      }
      .padding(10)

      if sourceName == nil {
        VStack(spacing: 6) {
          Image(systemName: "rectangle.on.rectangle.slash")
            .font(.system(size: 28, weight: .light))
          Text("No output source")
            .font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(.white.opacity(0.32))
        .allowsHitTesting(false)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 4))
    .overlay(
      RoundedRectangle(cornerRadius: 4)
        .strokeBorder(Color.programGreen, lineWidth: 3)
    )
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("output-tile")
    .accessibilityValue(accessibilityValue)
  }

  private var programTelemetry: TileTelemetry? {
    guard let index = snapshot.programTile else { return nil }
    return snapshot.tiles.first { $0.index == index }
  }

  private var sourceName: String? {
    programTelemetry?.displayName
  }

  private var isRewinding: Bool {
    let state = programTelemetry?.state
    return state == .scrubbing || state == .replaying
  }

  private var nameplate: some View {
    HStack(spacing: 6) {
      Text("Output")
        .font(.system(size: 10, weight: .heavy, design: .rounded))
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(Color.programGreen, in: RoundedRectangle(cornerRadius: 3))
        .foregroundStyle(.black)
      Text(sourceName ?? "—")
        .font(.system(size: 13, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(.black.opacity(0.45), in: Capsule())
  }

  private var offsetBadge: some View {
    Text(String(format: "−%.1fs", abs(programTelemetry?.offsetSeconds ?? 0)))
      .font(.system(size: 12, weight: .bold, design: .monospaced))
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Color.replayAmber, in: Capsule())
      .foregroundStyle(.black)
      .accessibilityIdentifier("output-offset")
  }

  private var returnToLiveButton: some View {
    Button {
      guard let tileIndex = snapshot.programTile else { return }
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
    .accessibilityIdentifier("return-to-live-output")
  }

  /// Text-only, like the tile values, so a Maestro selector can assert on it. See
  /// maestro/flows/matcher-check.yaml for why an id-plus-text selector cannot.
  private var accessibilityValue: String {
    let source = sourceName ?? "none"
    return "output src=\(source) mix=\(snapshot.audioMixContributors) "
      + "mixs=\(Int(snapshot.audioMixSeconds)) composed=\(snapshot.composedFrames)"
  }
}
