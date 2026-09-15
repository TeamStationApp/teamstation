import AppKit
import AVFoundation
import DirectorCore
import Distribution
import DistributorWire
import SwiftUI

/// One video the combined video can take: a camera of the export, or its primary output.
struct CombinedCandidate: Hashable {
  let name: String
  let track: Track
  /// What the still route calls it.
  let stillSource: SourceID

  /// The primary output first, when it is exported, then the exported cameras in the take's order.
  static func all(for recording: RecordingListing, tracks: [Track]) -> [CombinedCandidate] {
    var candidates: [CombinedCandidate] = []
    if recording.hasPrimary, tracks.contains(.primary) {
      candidates.append(CombinedCandidate(
        name: CombinedLayoutRules.primaryOutputName,
        track: .primary,
        stillSource: SourceID(DistributorProtocol.primaryStillCamera)
      ))
    }
    for camera in recording.cameras where tracks.contains(.camera(camera.sourceID)) {
      candidates.append(CombinedCandidate(name: camera.name, track: .camera(camera.sourceID), stillSource: camera.sourceID))
    }
    return candidates
  }
}

/// Chooses and lays out the combined video before an export: which exported files go in (up to
/// four, the primary output among them if it is exported), whose sound it carries, and where each
/// sits. The layout is remembered on the iPad by name and put back next time.
struct CombinedSheet: View {
  let recording: RecordingListing
  /// The files ticked for export that can go in, the primary output first.
  let candidates: [CombinedCandidate]
  let model: DistributorModel
  let onContinue: (CombinedPlan) -> Void
  let onCancel: () -> Void

  @State private var included: [String] = []
  @State private var assignment: [String: Quadrant] = [:]
  @State private var solo: SoloPlacement?
  @State private var audioCamera: String?
  @State private var stills: [String: NSImage] = [:]
  @State private var capReached = false
  @State private var drag: CanvasDrag?

  private static let canvasSpace = "combined-canvas"

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Combined video")
        .font(.title2.bold())
      HStack(alignment: .top, spacing: 20) {
        cameraList
          .frame(width: 220)
        canvas
          .frame(minWidth: 480, maxWidth: .infinity)
      }
      HStack {
        Spacer()
        Button("Cancel", role: .cancel) { onCancel() }
          .keyboardShortcut(.cancelAction)
        Button("Export") { finish() }
          .keyboardShortcut(.defaultAction)
          .disabled(included.count < 2)
          .accessibilityIdentifier("combined-export")
      }
    }
    .padding(24)
    .frame(width: 820, height: 540)
    .task { await setUp() }
  }

  // MARK: - Cameras

  private var cameraList: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Cameras").font(.headline)
      ForEach(candidates, id: \.name) { camera in
        HStack {
          Toggle(camera.name, isOn: inclusion(camera.name))
            .accessibilityIdentifier("combined-include-\(camera.name)")
          Spacer()
          Button {
            audioCamera = camera.name
          } label: {
            Image(systemName: audioCamera == camera.name ? "speaker.wave.2.fill" : "speaker")
          }
          .buttonStyle(.plain)
          .disabled(!included.contains(camera.name))
          .help("Use this camera's sound")
          .accessibilityIdentifier("combined-audio-\(camera.name)")
        }
      }
      if capReached {
        Text("A combined video holds up to four cameras")
          .font(.caption)
          .foregroundStyle(.red)
          .accessibilityIdentifier("combined-cap")
      }
      if included.count >= 2 {
        Text(included.count == 3
          ? "Drag a camera onto another to swap them, or into the empty space. The one beside the empty space slides along it and snaps to the centre."
          : "Drag a camera onto another to swap them.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
    }
  }

  private func inclusion(_ name: String) -> Binding<Bool> {
    Binding(
      get: { included.contains(name) },
      set: { isOn in
        if isOn {
          guard included.count < CombinedLayoutRules.maximumCameras else {
            capReached = true
            return
          }
          included = candidates.map(\.name).filter { included.contains($0) || $0 == name }
        } else {
          included.removeAll { $0 == name }
        }
        capReached = false
        rearrange()
      }
    )
  }

  /// Cameras still in keep their quadrants; new ones take the first free one. The sound stays with
  /// a camera that is still in.
  private func rearrange() {
    var next = assignment.filter { included.contains($0.key) }
    for name in included where next[name] == nil {
      if let free = Quadrant.readingOrder.first(where: { !next.values.contains($0) }) {
        next[name] = free
      }
    }
    assignment = next
    solo = included.count == 3 ? CombinedGeometry.effectiveSolo(assignment: next, saved: solo) : nil
    if let current = audioCamera, included.contains(current) { return }
    audioCamera = included.first
  }

  // MARK: - Canvas

  /// The cameras where they sit. While one is dragged it follows the pointer, the others show where
  /// they would go, and an outline shows where it would land.
  private var canvas: some View {
    GeometryReader { proxy in
      let size = CGSize(
        width: min(proxy.size.width, proxy.size.height * 16 / 9),
        height: min(proxy.size.width, proxy.size.height * 16 / 9) * 9 / 16
      )
      let resting = CombinedGeometry.frames(assignment: assignment, solo: solo, canvas: size)
      let preview = drag.map { self.landing(for: $0, resting: resting, canvas: size) }
      let shownSolo: SoloPlacement? = preview != nil ? preview?.solo : solo
      let frames = preview.map { CombinedGeometry.frames(assignment: $0.assignment, solo: $0.solo, canvas: size) } ?? resting
      ZStack(alignment: .topLeading) {
        Rectangle().fill(Color.black)
        ForEach(included, id: \.self) { name in
          if let frame = shownFrame(name, frames: frames, resting: resting) {
            tile(name, frame: frame, resting: resting, canvas: size)
          }
        }
        if let solo = shownSolo, solo.position == 0.5, let frame = frames[solo.camera] {
          guide(for: solo, frame: frame)
        }
        if let drag, let frame = frames[drag.camera] {
          Rectangle()
            .strokeBorder(Color.accentColor, lineWidth: 3)
            .frame(width: frame.width, height: frame.height)
            .position(x: frame.midX, y: frame.midY)
            .allowsHitTesting(false)
            .zIndex(2)
        }
      }
      .frame(width: size.width, height: size.height)
      .coordinateSpace(name: Self.canvasSpace)
      .clipped()
      .animation(.easeOut(duration: 0.15), value: preview?.assignment)
    }
    .aspectRatio(16 / 9, contentMode: .fit)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("combined-canvas")
  }

  /// The dragged camera under the pointer; every other camera where it would go.
  private func shownFrame(_ name: String, frames: [String: CGRect], resting: [String: CGRect]) -> CGRect? {
    guard let drag, drag.camera == name else { return frames[name] }
    return resting[name]?.offsetBy(dx: drag.translation.width, dy: drag.translation.height)
  }

  private func tile(_ name: String, frame: CGRect, resting: [String: CGRect], canvas: CGSize) -> some View {
    let isDragged = drag?.camera == name
    return ZStack(alignment: .bottomLeading) {
      if let image = stills[name] {
        Image(nsImage: image)
          .resizable()
          .aspectRatio(contentMode: .fit)
          .frame(width: frame.width, height: frame.height)
      } else {
        Rectangle().fill(Color.gray.opacity(0.35))
      }
      HStack(spacing: 4) {
        Text(name)
        if audioCamera == name { Image(systemName: "speaker.wave.2.fill") }
      }
      .font(.caption.bold())
      .padding(4)
      .background(Color.black.opacity(0.6))
      .foregroundStyle(.white)
    }
    .frame(width: frame.width, height: frame.height)
    .border(Color.white.opacity(0.25))
    .opacity(isDragged ? 0.85 : 1)
    .shadow(color: .black.opacity(isDragged ? 0.6 : 0), radius: 10)
    .contentShape(Rectangle())
    .gesture(
      DragGesture(minimumDistance: 2, coordinateSpace: .named(Self.canvasSpace))
        .onChanged { value in dragChanged(name, value: value, resting: resting, canvas: canvas) }
        .onEnded { value in dragEnded(name, value: value, resting: resting, canvas: canvas) }
    )
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
    .accessibilityIdentifier("combined-tile-\(name)")
    .position(x: frame.midX, y: frame.midY)
    .zIndex(isDragged ? 1 : 0)
  }

  /// Where `drag`'s camera would land if it were let go now.
  private func landing(
    for drag: CanvasDrag,
    resting: [String: CGRect],
    canvas: CGSize
  ) -> (assignment: [String: Quadrant], solo: SoloPlacement?) {
    let origin = resting[drag.camera]?.origin ?? .zero
    return CombinedGeometry.drop(
      drag.camera,
      pointer: drag.location,
      origin: CGPoint(x: origin.x + drag.translation.width, y: origin.y + drag.translation.height),
      assignment: assignment,
      solo: solo,
      canvas: canvas
    )
  }

  private func dragChanged(_ name: String, value: DragGesture.Value, resting: [String: CGRect], canvas: CGSize) {
    let next = CanvasDrag(camera: name, translation: value.translation, location: value.location)
    let wasCentred = drag.map { isCentred(landing(for: $0, resting: resting, canvas: canvas).solo, name) } ?? false
    drag = next
    if !wasCentred, isCentred(landing(for: next, resting: resting, canvas: canvas).solo, name) {
      NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    }
  }

  private func dragEnded(_ name: String, value: DragGesture.Value, resting: [String: CGRect], canvas: CGSize) {
    let result = landing(
      for: CanvasDrag(camera: name, translation: value.translation, location: value.location),
      resting: resting,
      canvas: canvas
    )
    withAnimation(.easeOut(duration: 0.15)) {
      assignment = result.assignment
      solo = result.solo
      drag = nil
    }
  }

  private func isCentred(_ solo: SoloPlacement?, _ name: String) -> Bool {
    solo?.camera == name && solo?.position == 0.5
  }

  /// A line through the centre of the solo's column or row, while it sits there.
  private func guide(for solo: SoloPlacement, frame: CGRect) -> some View {
    Rectangle()
      .fill(Color.accentColor)
      .frame(
        width: solo.axis == .horizontal ? 2 : frame.width,
        height: solo.axis == .vertical ? 2 : frame.height
      )
      .offset(
        x: solo.axis == .horizontal ? frame.midX - 1 : frame.minX,
        y: solo.axis == .vertical ? frame.midY - 1 : frame.minY
      )
      .allowsHitTesting(false)
      .zIndex(2)
  }

  // MARK: - Start and finish

  private func setUp() async {
    let saved = model.settings?.combinedLayout ?? CombinedLayoutSettings()
    let names = candidates.map(\.name)
    included = CombinedLayoutRules.initialInclusion(exported: names, saved: saved)
    assignment = CombinedLayoutRules.assign(included, saved: saved)
    solo = included.count == 3 ? CombinedGeometry.effectiveSolo(assignment: assignment, saved: saved.solo) : nil
    audioCamera = CombinedLayoutRules.audioCamera(included: included, withAudio: Set(names), saved: saved.audioCamera)
    let length = (recording.endedAt ?? recording.startedAt) - recording.startedAt
    let at = length > 0 ? min(10, length / 2) : 10
    for camera in candidates {
      if let image = await localStill(camera, at: at) {
        stills[camera.name] = image
      } else if !model.isRecording, !model.isStreaming,
                let data = await model.still(recordingID: recording.id, camera: camera.stillSource, at: at),
                let image = NSImage(data: data) {
        stills[camera.name] = image
      }
    }
  }

  /// A still from the file already on this Mac, so the iPad is asked for nothing it need not do.
  private func localStill(_ camera: CombinedCandidate, at seconds: Double) async -> NSImage? {
    guard let destination = model.destination, model.inventory(of: recording)?.files[camera.track]?.isSaved == true else {
      return nil
    }
    let file = DistributionRun.folder(for: recording, in: destination)
      .appendingPathComponent(DistributionRun.filename(for: camera.track, of: recording))
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 640, height: 360)
    guard let image = try? await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)).image else {
      return nil
    }
    return NSImage(cgImage: image, size: .zero)
  }

  private func finish() {
    let assignment = self.assignment
    let included = self.included
    let solo = self.solo
    let audioCamera = self.audioCamera
    let frames = CombinedGeometry.frames(assignment: assignment, solo: solo)
    let chosen = candidates.filter { included.contains($0.name) }
    Task {
      await model.updateSettings {
        $0.combinedLayout = CombinedLayoutRules.remember(
          assignment,
          included: included,
          solo: solo,
          audioCamera: audioCamera,
          in: $0.combinedLayout
        )
      }
    }
    onContinue(CombinedPlan(
      inputs: chosen.map { (name: $0.name, track: $0.track) },
      frames: frames,
      audioCamera: audioCamera
    ))
  }
}

/// A camera being dragged across the canvas: how far it has moved, and where the pointer is.
private struct CanvasDrag: Equatable {
  var camera: String
  var translation: CGSize
  var location: CGPoint
}
