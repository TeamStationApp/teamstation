import CameramanControlUI
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
  @State private var draggingProgram = false
  @State private var programDragLocation: CGPoint = .zero
  @State private var programGrabOffset = CGSize.zero
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

        // `DP:`, not "Dropped packets:". The header is the one row that has to
        // hold everything at once, and two words were costing more of it than
        // they were worth beside a number that is nearly always 0. What it is
        // spoken as keeps the whole phrase.
        Text("DP: \(environment.streamDroppedPackets)")
          .font(.system(size: 13, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .foregroundStyle(.white.opacity(0.9))
          .accessibilityIdentifier("header-stream-drops")
          .accessibilityLabel("\(environment.streamDroppedPackets) dropped packets")
      }

      Spacer()

      // Swallows its taps so a press on the pill does not fall through to Recordings.
      ThermalBadge(
        level: environment.displayedThermalLevel,
        animate: !environment.launch.isUITest,
        identifier: "header-thermal",
        passesTouches: false
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

      if environment.isMacConnected { macPill }
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

  /// GS Distributor is attached by cable. Shown so the operator knows why the iPad is busy, and
  /// that it must stay open and in front until the Mac has what it needs.
  private var macPill: some View {
    Label(environment.distributorExport == nil ? "MAC" : "EXPORTING", systemImage: "cable.connector")
      .font(.system(size: 11, weight: .heavy, design: .rounded))
      .tracking(1)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 8))
      .foregroundStyle(.white.opacity(0.85))
      .accessibilityIdentifier("mac-pill")
      .accessibilityLabel("GS Distributor connected")
  }

  private func programTransportButton(
    isActive: Bool,
    idleLabel: String,
    activeLabel: String,
    identifier: String,
    accessibilityValue: String,
    action: @escaping () -> Void
  ) -> some View {
    // Neither can start while GS Distributor is exporting; one already running can still stop.
    let blocked = !isActive && environment.distributorExport != nil
    return Button(action: action) {
      PulsingTransportLabel(isActive: isActive, idleLabel: idleLabel, activeLabel: activeLabel)
    }
    .buttonStyle(.plain)
    .disabled(blocked)
    .opacity(blocked ? 0.35 : 1)
    .accessibilityIdentifier(identifier)
    .accessibilityValue(accessibilityValue)
  }

  /// A 3×3 grid with four cells merged into Output, top-left until the operator moves it:
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
  /// Long-pressing Output and dragging it parks it in the corner of the quadrant it is dropped in,
  /// at the same size; the source tiles take the cells it leaves, in reading order. Long-pressing a
  /// source tile and dragging it over another swaps them; the order is by source number, not by
  /// which camera is on that source.
  private var grid: some View {
    GeometryReader { proxy in
      let geometry = SourceGridGeometry(
        size: proxy.size,
        programCorner: environment.sourceLayout.programCorner
      )
      ZStack(alignment: .topLeading) {
        programTile(geometry: geometry)

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
        Color.clear
          .frame(width: 1, height: 1)
          .allowsHitTesting(false)
          .accessibilityIdentifier("output-corner")
          .accessibilityValue("corner=\(environment.sourceLayout.programCorner.rawValue)")
      }
      .onAppear { environment.smallTileWidth = Double(geometry.tileWidth) }
      .onChange(of: geometry.tileWidth) { _, value in environment.smallTileWidth = Double(value) }
      .onChange(of: environment.sourceLayout.order) { _, _ in
        guard draggingSource != nil else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
      .onChange(of: environment.sourceLayout.programCorner) { _, _ in
        guard draggingProgram else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    }
  }

  private func programTile(geometry: SourceGridGeometry) -> some View {
    let frame = geometry.programFrame
    let center: CGPoint = {
      if draggingProgram {
        return CGPoint(
          x: programDragLocation.x - programGrabOffset.width,
          y: programDragLocation.y - programGrabOffset.height
        )
      }
      return CGPoint(x: frame.midX, y: frame.midY)
    }()

    return ProgramTileView(
      renderer: environment.router.programRenderer,
      snapshot: environment.snapshot
    )
    .frame(width: frame.width, height: frame.height)
    .scaleEffect(draggingProgram ? 1.03 : 1)
    .shadow(
      color: .black.opacity(draggingProgram ? 0.45 : 0),
      radius: draggingProgram ? 18 : 0,
      y: draggingProgram ? 10 : 0
    )
    .position(center)
    .zIndex(draggingProgram ? 10 : 0)
    .simultaneousGesture(programMoveGesture(geometry: geometry))
  }

  /// Same long-press-then-drag as a source reorder. Output follows the finger, and the sources
  /// reflow the moment its centre crosses into another quadrant, so the drop only settles it.
  private func programMoveGesture(geometry: SourceGridGeometry) -> some Gesture {
    LongPressGesture(minimumDuration: 0.45, maximumDistance: 14)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("directorGrid")))
      .onChanged { value in
        guard case .second(true, let drag) = value, draggingSource == nil else { return }
        if !draggingProgram {
          beginProgramMove(geometry: geometry, location: drag?.location)
        }
        guard let drag else { return }
        programDragLocation = drag.location
        let corner = geometry.programCorner(nearest: CGPoint(
          x: drag.location.x - programGrabOffset.width,
          y: drag.location.y - programGrabOffset.height
        ))
        if corner != environment.sourceLayout.programCorner {
          withAnimation(.easeInOut(duration: 0.18)) {
            environment.moveProgram(to: corner)
          }
        }
      }
      .onEnded { _ in
        endProgramMove()
      }
  }

  private func beginProgramMove(geometry: SourceGridGeometry, location: CGPoint?) {
    let frame = geometry.programFrame
    let point = location ?? CGPoint(x: frame.midX, y: frame.midY)
    draggingProgram = true
    environment.isDraggingOutput = true
    programDragLocation = point
    programGrabOffset = CGSize(width: point.x - frame.midX, height: point.y - frame.midY)
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }

  private func endProgramMove() {
    guard draggingProgram else { return }
    environment.commitSourceLayout()
    environment.isDraggingOutput = false
    environment.ignoreProgramTapUntil = ProcessInfo.processInfo.systemUptime + 0.35
    withAnimation(.easeInOut(duration: 0.18)) {
      draggingProgram = false
      programGrabOffset = .zero
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
          guard !draggingProgram else { return }
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
