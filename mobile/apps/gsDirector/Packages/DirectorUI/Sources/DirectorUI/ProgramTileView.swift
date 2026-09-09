import DirectorPipeline
import SwiftUI

/// The merged 2×2 cell: what Output actually looks like, overlays included.
///
/// It renders the composited frame rather than the source tile's, so the operator is watching the
/// same pixels the encoder is being handed. That distinction is the reason the tile exists — a
/// graphic that is mispositioned, stale or missing is invisible in the source tiles, and until now
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

      VStack(spacing: 0) {
        HStack(alignment: .center, spacing: 6) {
          if isRewinding {
            returnToLiveButton
            offsetBadge
          }
          nameplate
          Spacer()
          if !isRewinding {
            statsPills
          }
        }
        Spacer()
          .allowsHitTesting(false)
        if snapshot.programSource != nil {
          ReplayHotkeyBar(
            sourceIndex: snapshot.programSource ?? 0,
            accessibilityPrefix: "output",
            slowMotionRate: environment.config.replaySlowMotionRate
          ) { seconds, rate in
            guard let sourceIndex = snapshot.programSource else { return }
            environment.startInstantReplay(sourceIndex: sourceIndex, seconds: seconds, rate: rate)
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
    .accessibilityIdentifier("output")
    .accessibilityValue(accessibilityValue)
  }

  private var programTelemetry: TileTelemetry? {
    snapshot.programTile
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

  /// Recording clock, output rate, the on-air camera's loss and delay — see `OutputStats` for
  /// why these four. Hidden in rewind, where the header holds Return to Live and the offset.
  private var statsPills: some View {
    HStack(spacing: 6) {
      ForEach(OutputStats.pills(snapshot), id: \.id) { pill in
        StatPill(text: pill.text, identifier: pill.id)
      }
    }
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
      guard let sourceIndex = snapshot.programSource else { return }
      environment.returnToLive(sourceIndex: sourceIndex)
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
      + "mixs=\(Int(snapshot.audioMixSeconds)) composed=\(snapshot.composedFrames) "
      + OutputStats.accessibilityValue(snapshot)
  }
}
