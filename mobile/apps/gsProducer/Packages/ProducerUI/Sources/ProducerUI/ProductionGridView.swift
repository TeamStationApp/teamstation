import ProducerPipeline
import SwiftUI

/// Spec 6.2: the main production screen. Four tiles, one program, one record button.
public struct ProductionGridView: View {
  @Environment(AppEnvironment.self) private var environment

  public init() {}

  public var body: some View {
    ZStack(alignment: .topLeading) {
      Color.deckBackground.ignoresSafeArea()

      VStack(spacing: 10) {
        toolbar
        grid
      }
      // Status bar is hidden, so padding from the top of the display keeps toolbar hits
      // out of the Control Center hot corner.
      .padding(EdgeInsets(top: 28, leading: 12, bottom: 12, trailing: 12))

      if environment.config.showDebugHUD {
        DebugHUD(snapshot: environment.snapshot)
          .padding(.top, 64)
          .padding(.leading, 14)
          .allowsHitTesting(false)
      }
    }
    .overlay(alignment: .bottom) {
      StatusToast()
    }
  }

  private var toolbar: some View {
    HStack(spacing: 14) {
      Menu {
        Button {
          environment.openCameras()
        } label: {
          Label("Cameras", systemImage: "video")
        }
        .accessibilityIdentifier("menu-cameras")
        Button {
          environment.activeSheet = .recordings
        } label: {
          Label("Recordings", systemImage: "film.stack")
        }
        .accessibilityIdentifier("menu-recordings")
        Button {
          environment.activeSheet = .perfHarness
        } label: {
          Label("Performance", systemImage: "speedometer")
        }
        .accessibilityIdentifier("menu-performance")
        Button {
          environment.activeSheet = .settings
        } label: {
          Label("Settings", systemImage: "gearshape")
        }
        .accessibilityIdentifier("menu-settings")
      } label: {
        toolbarIcon("line.3.horizontal")
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("menu-button")
      .accessibilityLabel("Menu")

      Text("GS PRODUCER")
        .font(.system(size: 15, weight: .black, design: .rounded))
        .tracking(2.5)
        .foregroundStyle(.white.opacity(0.9))

      Spacer()

      Button {
        environment.activeSheet = .recordings
      } label: {
        toolbarIcon("film.stack")
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("recordings-button")
      .accessibilityLabel("Recordings")

      Button {
        environment.activeSheet = .perfHarness
      } label: {
        toolbarIcon("speedometer")
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("perf-button")

      Button {
        environment.openCameras()
      } label: {
        toolbarIcon("video")
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("cameras-button")
      .accessibilityLabel("Cameras")

      Button {
        environment.activeSheet = .settings
      } label: {
        toolbarIcon("gearshape")
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("settings-button")

      archivePill
      recordButton
    }
  }

  private func toolbarIcon(_ name: String) -> some View {
    Image(systemName: name)
      .font(.system(size: 15, weight: .semibold))
      .frame(width: 38, height: 34)
      .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 8))
      .foregroundStyle(.white.opacity(0.85))
  }

  /// How many cameras are actually writing, always visible rather than buried in a debug view: an
  /// archive that quietly stopped — a full disk, a writer that failed — has to be something the
  /// operator can see during the game rather than discover after it.
  private var archivePill: some View {
    let tiles = environment.snapshot.tiles.filter { $0.sourceID != nil }
    let writing = tiles.filter(\.isArchiving).count
    let complete = writing == tiles.count
    let label = environment.isRecording ? "REC \(writing)/\(tiles.count)" : "READY"
    return Text(label)
      .font(.system(size: 11, weight: .heavy, design: .rounded))
      .tracking(1)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(
        complete ? Color.deckPanel : Color.replayAmber,
        in: RoundedRectangle(cornerRadius: 8)
      )
      .foregroundStyle(complete ? .white.opacity(0.55) : .black)
      .accessibilityIdentifier("archive-pill")
      .accessibilityValue(
        environment.isRecording
          ? "\(writing) of \(tiles.count) cameras archiving their own stream"
          : "Not recording"
      )
  }

  private var recordButton: some View {
    Button {
      environment.toggleRecording()
    } label: {
      HStack(spacing: 8) {
        if environment.isRecording {
          RoundedRectangle(cornerRadius: 2).frame(width: 11, height: 11)
        } else {
          Circle().frame(width: 13, height: 13)
        }
        Text(environment.isRecording ? "STOP" : "RECORD")
          .font(.system(size: 13, weight: .heavy, design: .rounded))
          .tracking(1)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .background(
        environment.isRecording ? Color.recordRed : Color.recordRed.opacity(0.18),
        in: RoundedRectangle(cornerRadius: 8)
      )
      .foregroundStyle(environment.isRecording ? .white : Color.recordRed)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("record-button")
    .accessibilityValue(environment.isRecording ? "recording" : "stopped")
  }

  /// A 3×3 grid whose top-left four cells are merged into Output:
  ///
  /// ```
  /// ┌─────────────┬───────┐
  /// │             │ cam 1 │
  /// │   Output    ├───────┤
  /// │             │ cam 2 │
  /// ├───────┬─────┼───────┤
  /// │ cam 3 │ cam4│ cam 5 │
  /// └───────┴─────┴───────┘
  /// ```
  ///
  /// Output gets the large cell because it is the thing being broadcast; the five sources
  /// are there to be watched for the next cut, which needs less resolution than judging the output
  /// does.
  private var grid: some View {
    GeometryReader { geometry in
      let spacing: CGFloat = 8
      let width = (geometry.size.width - spacing * 2) / 3
      let height = (geometry.size.height - spacing * 2) / 3
      let programWidth = width * 2 + spacing
      let programHeight = height * 2 + spacing

      VStack(spacing: spacing) {
        HStack(spacing: spacing) {
          ProgramTileView(
            renderer: environment.router.programRenderer,
            snapshot: environment.snapshot
          )
          .frame(width: programWidth, height: programHeight)

          VStack(spacing: spacing) {
            tile(0).frame(width: width, height: height)
            tile(1).frame(width: width, height: height)
          }
        }
        HStack(spacing: spacing) {
          tile(2).frame(width: width, height: height)
          tile(3).frame(width: width, height: height)
          tile(4).frame(width: width, height: height)
        }
      }
      .onAppear { environment.smallTileWidth = Double(width) }
      .onChange(of: width) { _, value in environment.smallTileWidth = Double(value) }
    }
  }

  private func tile(_ index: Int) -> some View {
    TileView(
      tileIndex: index,
      pipeline: environment.router.pipeline(at: index),
      telemetry: environment.snapshot.tiles.first { $0.index == index } ?? TileTelemetry(index: index)
    )
  }
}
