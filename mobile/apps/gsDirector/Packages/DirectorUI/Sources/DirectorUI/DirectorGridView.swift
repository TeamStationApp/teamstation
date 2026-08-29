import DirectorCore
import DirectorPipeline
import SwiftUI
import UIKit

/// Spec 6.2: the main directing screen. Four tiles, one program, one record button.
public struct DirectorGridView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var draggingSource: Int?
  @State private var dragLocation: CGPoint = .zero
  @State private var dragGrabOffset = CGSize.zero
  @State private var slideToStop: SlideToStopTarget?
  @State private var toolbarHeight: CGFloat = 36

  public init() {}

  public var body: some View {
    ZStack(alignment: .topLeading) {
      Color.deckBackground.ignoresSafeArea()

      VStack(spacing: 10) {
        toolbar
          .background {
            GeometryReader { geometry in
              Color.clear.preference(key: ToolbarHeightKey.self, value: geometry.size.height)
            }
          }
        grid
      }
      // The status bar draws in this top inset over the deck. Do not add a second safe-area
      // gap — the toolbar is already below the system time / Wi-Fi / battery.
      .padding(EdgeInsets(top: 28, leading: 12, bottom: 12, trailing: 12))
      .onPreferenceChange(ToolbarHeightKey.self) { toolbarHeight = $0 }

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
    .overlay {
      if let slideToStop {
        ZStack(alignment: .topTrailing) {
          Color.black.opacity(0.55)
            .ignoresSafeArea()
            .accessibilityIdentifier("slide-to-stop-cancel")
            .accessibilityLabel("Cancel")
            .accessibilityAddTraits(.isButton)
            .onTapGesture { self.slideToStop = nil }
          SlideToStopOverlay(
            target: slideToStop,
            onStop: {
              self.slideToStop = nil
              switch slideToStop {
              case .stream:
                Task { await environment.stopStreaming() }
              case .record:
                Task { await environment.stopRecording() }
              }
            }
          )
          .padding(.top, 28 + toolbarHeight + 8)
          .padding(.trailing, 12)
        }
      }
    }
    .ignoresSafeArea(.container, edges: .top)
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

      Text("GS DIRECTOR")
        .font(.system(size: 15, weight: .black, design: .rounded))
        .tracking(2.5)
        .foregroundStyle(.white.opacity(0.9))

      if environment.isStreaming {
        Text(String(format: "%.2f Mbps", environment.streamMegabitsPerSecond))
          .font(.system(size: 13, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .foregroundStyle(.white.opacity(0.9))
          .accessibilityIdentifier("header-stream-mbps")
          .accessibilityLabel("\(String(format: "%.2f", environment.streamMegabitsPerSecond)) megabits per second")

        Text("Dropped packets: \(environment.streamDroppedPackets)")
          .font(.system(size: 13, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .foregroundStyle(.white.opacity(0.9))
          .accessibilityIdentifier("header-stream-drops")
          .accessibilityLabel("\(environment.streamDroppedPackets) dropped packets")
      }

      Spacer()

      ThermalBadge(
        level: environment.displayedThermalLevel,
        animate: !environment.launch.isUITest
      )

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
      programTransportButton(
        isActive: environment.isStreaming,
        idleLabel: "STREAM",
        activeLabel: "STREAMING",
        identifier: "stream-button",
        accessibilityValue: environment.isStreaming ? "streaming" : "stopped"
      ) {
        if environment.isStreaming {
          slideToStop = .stream
        } else {
          environment.toggleStreaming()
        }
      }
      programTransportButton(
        isActive: environment.isRecording,
        idleLabel: "RECORD",
        activeLabel: "RECORDING",
        identifier: "record-button",
        accessibilityValue: environment.isRecording ? "recording" : "stopped"
      ) {
        if environment.isRecording {
          slideToStop = .record
        } else {
          environment.toggleRecording()
        }
      }
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

  private func programTransportButton(
    isActive: Bool,
    idleLabel: String,
    activeLabel: String,
    identifier: String,
    accessibilityValue: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      PulsingTransportLabel(isActive: isActive, idleLabel: idleLabel, activeLabel: activeLabel)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
    .accessibilityValue(accessibilityValue)
  }

  /// A 3×3 grid whose top-left four cells are merged into Output:
  ///
  /// ```
  /// ┌─────────────┬───────┐
  /// │             │ src 1 │
  /// │   Output    ├───────┤
  /// │             │ src 2 │
  /// ├───────┬─────┼───────┤
  /// │ src 3 │src 4│ src 5 │
  /// └───────┴─────┴───────┘
  /// ```
  ///
  /// Output stays in the large cell. Long-pressing a source tile and dragging it over another
  /// swaps them; the order is by source number, not by which camera is on that source.
  private var grid: some View {
    GeometryReader { proxy in
      let geometry = SourceGridGeometry(size: proxy.size)
      ZStack(alignment: .topLeading) {
        ProgramTileView(
          renderer: environment.router.programRenderer,
          snapshot: environment.snapshot
        )
        .frame(width: geometry.programFrame.width, height: geometry.programFrame.height)
        .position(x: geometry.programFrame.midX, y: geometry.programFrame.midY)

        ForEach(0 ..< SourceIndex.count, id: \.self) { sourceIndex in
          sourceTile(sourceIndex, geometry: geometry)
            .id(sourceIndex)
        }
      }
      .coordinateSpace(name: "directorGrid")
      .overlay(alignment: .topLeading) {
        Color.clear
          .frame(width: 1, height: 1)
          .allowsHitTesting(false)
          .accessibilityIdentifier("source-layout")
          .accessibilityValue("order=\(environment.sourceLayout.displayOrder)")
      }
      .onAppear { environment.smallTileWidth = Double(geometry.tileWidth) }
      .onChange(of: geometry.tileWidth) { _, value in environment.smallTileWidth = Double(value) }
      .onChange(of: environment.sourceLayout.order) { _, _ in
        guard draggingSource != nil else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    }
  }

  private func sourceTile(_ sourceIndex: Int, geometry: SourceGridGeometry) -> some View {
    let slot = environment.sourceLayout.slot(forSource: sourceIndex)
    let frame = geometry.slotFrames[slot]
    let isDragging = draggingSource == sourceIndex
    let center: CGPoint = {
      if isDragging {
        return CGPoint(
          x: dragLocation.x - dragGrabOffset.width,
          y: dragLocation.y - dragGrabOffset.height
        )
      }
      return CGPoint(x: frame.midX, y: frame.midY)
    }()

    return tile(sourceIndex)
      .frame(width: geometry.tileWidth, height: geometry.tileHeight)
      .scaleEffect(isDragging ? 1.05 : 1)
      .shadow(
        color: .black.opacity(isDragging ? 0.45 : 0),
        radius: isDragging ? 18 : 0,
        y: isDragging ? 10 : 0
      )
      .position(center)
      .zIndex(isDragging ? 10 : 0)
      .simultaneousGesture(reorderGesture(sourceIndex: sourceIndex, geometry: geometry))
  }

  private func reorderGesture(sourceIndex: Int, geometry: SourceGridGeometry) -> some Gesture {
    LongPressGesture(minimumDuration: 0.45, maximumDistance: 14)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("directorGrid")))
      .onChanged { value in
        switch value {
        case .second(true, let drag):
          if draggingSource == nil {
            beginReorder(sourceIndex: sourceIndex, geometry: geometry, location: drag?.location)
          }
          guard draggingSource == sourceIndex, let drag else { return }
          dragLocation = drag.location
          if let slot = geometry.slot(containing: drag.location),
             environment.sourceLayout.slot(forSource: sourceIndex) != slot {
            withAnimation(.easeInOut(duration: 0.18)) {
              environment.moveSource(sourceIndex, toSlot: slot)
            }
          }
        default:
          break
        }
      }
      .onEnded { _ in
        endReorder(sourceIndex: sourceIndex)
      }
  }

  private func beginReorder(sourceIndex: Int, geometry: SourceGridGeometry, location: CGPoint?) {
    let frame = geometry.slotFrames[environment.sourceLayout.slot(forSource: sourceIndex)]
    let point = location ?? CGPoint(x: frame.midX, y: frame.midY)
    draggingSource = sourceIndex
    environment.draggingSourceIndex = sourceIndex
    dragLocation = point
    dragGrabOffset = CGSize(width: point.x - frame.midX, height: point.y - frame.midY)
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }

  private func endReorder(sourceIndex: Int) {
    guard draggingSource == sourceIndex else { return }
    environment.commitSourceLayout()
    environment.draggingSourceIndex = nil
    environment.ignoreProgramTapUntil = ProcessInfo.processInfo.systemUptime + 0.35
    draggingSource = nil
    dragGrabOffset = .zero
  }

  private func tile(_ index: Int) -> some View {
    TileView(
      sourceIndex: index,
      pipeline: environment.router.pipeline(at: index),
      telemetry: environment.snapshot.tiles.first { $0.index == index } ?? TileTelemetry(index: index)
    )
  }
}

private struct PulsingTransportLabel: View {
  let isActive: Bool
  let idleLabel: String
  let activeLabel: String
  @Environment(AppEnvironment.self) private var environment
  @State private var pulseBright = false

  private static let darkerRed = Color(red: 0.78, green: 0.16, blue: 0.18)
  private static let brighterRed = Color(red: 1.0, green: 0.32, blue: 0.36)

  var body: some View {
    HStack(spacing: 8) {
      if isActive {
        RoundedRectangle(cornerRadius: 2).frame(width: 11, height: 11)
      } else {
        Circle().frame(width: 13, height: 13)
      }
      Text(isActive ? activeLabel : idleLabel)
        .font(.system(size: 13, weight: .heavy, design: .rounded))
        .tracking(1)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .background(fill, in: RoundedRectangle(cornerRadius: 8))
    .foregroundStyle(isActive ? Color.white : Color.recordRed)
    .onChange(of: isActive) { _, active in
      pulseBright = false
      guard active, !environment.launch.isUITest else { return }
      withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
        pulseBright = true
      }
    }
    .onAppear {
      guard isActive, !environment.launch.isUITest else { return }
      withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
        pulseBright = true
      }
    }
  }

  private var fill: Color {
    if !isActive { return Color.recordRed.opacity(0.18) }
    return pulseBright ? Self.brighterRed : Self.darkerRed
  }
}

private struct ToolbarHeightKey: PreferenceKey {
  static let defaultValue: CGFloat = 36

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}
