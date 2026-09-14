import DirectorCore
import Distribution
import DistributorWire
import SwiftUI

/// The iPad's recordings, laid out like GS Director's Recordings screen: the takes on the left,
/// marked for deletion with a circle, and the chosen take's files on the right.
struct RecordingsView: View {
  let model: DistributorModel

  @State private var selectedID: Int64?
  @State private var marked: Set<Int64> = []
  @State private var confirmingDelete = false
  @State private var includesPrimary = true
  @State private var includedCameras: Set<String> = []
  @State private var step: ExportStep?

  var body: some View {
    HSplitView {
      // Select All and Delete sit over the takes they act on, below the window's title bar.
      VStack(spacing: 0) {
        HStack {
          Button(allMarkable ? "Deselect All" : "Select All") { toggleAll() }
            .disabled(markable.isEmpty)
            .accessibilityIdentifier("recordings-select-all")
          Spacer()
          Button(role: .destructive) {
            confirmingDelete = true
          } label: {
            Label("Delete", systemImage: "trash")
          }
          .disabled(marked.isEmpty)
          .accessibilityIdentifier("recordings-delete")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        Divider()
        recordingList
      }
      .frame(minWidth: 280, idealWidth: 340)
      filesColumn
        .frame(minWidth: 320, maxWidth: .infinity, maxHeight: .infinity)
    }
    .sheet(isPresented: Binding(get: { model.run != nil }, set: { if !$0 { model.dismissRun() } })) {
      if let run = model.run {
        ExportProgressView(run: run) { model.dismissRun() }
          .interactiveDismissDisabled(!run.isFinished)
      }
    }
    .confirmationDialog(
      "Delete \(marked.count) recording\(marked.count == 1 ? "" : "s") from the iPad?",
      isPresented: $confirmingDelete
    ) {
      Button("Delete", role: .destructive) {
        let ids = Array(marked)
        marked.removeAll()
        Task { await model.delete(ids) }
      }
    } message: {
      Text("Their camera files, primary output and prepared exports are removed from GS Director.")
    }
    .onChange(of: model.recordings) { _, recordings in
      let present = Set(recordings.map(\.id))
      marked.formIntersection(present.subtracting(recordings.filter(\.isLive).map(\.id)))
      if let selectedID, !present.contains(selectedID) { self.selectedID = nil }
    }
    .onChange(of: selectedID) { _, _ in
      includesPrimary = true
      includedCameras = Set(selected?.cameras.map(\.sourceID.rawValue) ?? [])
    }
  }

  // MARK: - Recordings

  private var recordingList: some View {
    List(selection: $selectedID) {
      ForEach(model.recordings, id: \.id) { recording in
        HStack(spacing: 10) {
          Button {
            toggleMark(recording)
          } label: {
            Image(systemName: marked.contains(recording.id) ? "checkmark.circle.fill" : "circle")
              .foregroundStyle(recording.isLive ? Color.secondary.opacity(0.4) : .accentColor)
          }
          .buttonStyle(.plain)
          .disabled(recording.isLive)
          .accessibilityIdentifier("recording-mark-\(recording.id)")

          VStack(alignment: .leading, spacing: 2) {
            Text(Self.stamp(recording.startedAt.date))
              .font(.body.monospacedDigit())
            TimelineView(.periodic(from: .now, by: 1)) { context in
              Text(Self.length(of: recording, now: context.date))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
          }
          Spacer()
          if recording.isLive {
            Text("REC")
              .font(.caption.bold())
              .foregroundStyle(.red)
          }
        }
        .tag(recording.id)
        .accessibilityIdentifier("recording-row-\(recording.id)")
      }
    }
  }

  // MARK: - Files

  private var selected: RecordingListing? {
    model.recordings.first { $0.id == selectedID }
  }

  @ViewBuilder
  private var filesColumn: some View {
    if let recording = selected {
      List {
        if recording.hasPrimary {
          Toggle("Primary output", isOn: $includesPrimary)
            .accessibilityIdentifier("recording-file-program")
        }
        ForEach(recording.cameras, id: \.sourceID.rawValue) { camera in
          Toggle(camera.name, isOn: cameraBinding(camera.sourceID))
            .accessibilityIdentifier("recording-file-\(camera.sourceID.slug)")
        }
      }
      .id(recording.id)
      .safeAreaInset(edge: .bottom) {
        HStack {
          if recording.isLive {
            Text("This take is still being recorded.")
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button("Export") { startExport(recording) }
            .keyboardShortcut(.defaultAction)
            .disabled(recording.isLive || chosenTracks(recording).isEmpty || model.isExporting)
            .accessibilityIdentifier("recordings-export")
        }
        .padding(12)
        .background(.bar)
        .sheet(item: $step) { step in
          switch step {
          case let .combine(recording, tracks, cameras):
            CombinedSheet(
              recording: recording,
              cameras: cameras,
              model: model,
              onContinue: { plan in proceed(recording, tracks: tracks, combined: plan) },
              onCancel: { self.step = nil }
            )
          case let .upload(recording, tracks, combined):
            UploadSheet(
              recording: recording,
              tracks: tracks,
              makesCombined: combined != nil,
              model: model,
              onContinue: { upload in
                self.step = nil
                model.export(recording, tracks: tracks, combined: combined, upload: upload)
              },
              onCancel: { self.step = nil }
            )
          }
        }
      }
    } else {
      ContentUnavailableView("Choose a recording", systemImage: "film.stack")
    }
  }

  /// What an export asks before it starts.
  enum ExportStep: Identifiable {
    /// The combined video's layout.
    case combine(recording: RecordingListing, tracks: [Track], cameras: [CameraListing])
    /// The title and which files go to PeerTube.
    case upload(recording: RecordingListing, tracks: [Track], combined: CombinedPlan?)

    var id: String {
      switch self {
      case .combine: "combine"
      case .upload: "upload"
      }
    }
  }

  /// With a combined video on and two or more cameras ticked, the layout comes first; with
  /// PeerTube uploads on, the title next; then the export starts.
  private func startExport(_ recording: RecordingListing) {
    let tracks = chosenTracks(recording)
    let cameras = recording.cameras.filter { includedCameras.contains($0.sourceID.rawValue) }
    if model.settings?.createCombined == true, cameras.count >= 2 {
      step = .combine(recording: recording, tracks: tracks, cameras: cameras)
    } else {
      proceed(recording, tracks: tracks, combined: nil)
    }
  }

  private func proceed(_ recording: RecordingListing, tracks: [Track], combined: CombinedPlan?) {
    if model.settings?.peerTube.enabled == true {
      if case .signedIn = model.peerTube {
        step = .upload(recording: recording, tracks: tracks, combined: combined)
        return
      }
      model.problem = "PeerTube uploads are on, but GS Director is not signed in, so nothing is uploaded."
    }
    step = nil
    model.export(recording, tracks: tracks, combined: combined)
  }

  /// The primary output first, then the cameras in the take's order, as they are ticked.
  private func chosenTracks(_ recording: RecordingListing) -> [Track] {
    var tracks: [Track] = []
    if recording.hasPrimary && includesPrimary { tracks.append(.primary) }
    tracks += recording.cameras
      .filter { includedCameras.contains($0.sourceID.rawValue) }
      .map { .camera($0.sourceID) }
    return tracks
  }

  private func cameraBinding(_ sourceID: SourceID) -> Binding<Bool> {
    Binding(
      get: { includedCameras.contains(sourceID.rawValue) },
      set: { isOn in
        if isOn {
          includedCameras.insert(sourceID.rawValue)
        } else {
          includedCameras.remove(sourceID.rawValue)
        }
      }
    )
  }

  // MARK: - Marking

  /// Everything but the take being recorded.
  private var markable: [Int64] {
    model.recordings.filter { !$0.isLive }.map(\.id)
  }

  private var allMarkable: Bool {
    !markable.isEmpty && Set(markable).isSubset(of: marked)
  }

  private func toggleAll() {
    marked = allMarkable ? [] : Set(markable)
  }

  private func toggleMark(_ recording: RecordingListing) {
    guard !recording.isLive else { return }
    if marked.contains(recording.id) {
      marked.remove(recording.id)
    } else {
      marked.insert(recording.id)
    }
  }

  // MARK: - Labels

  /// `yyyy-MM-dd HH:mm:ss`, local time, as the Director shows it.
  static func stamp(_ date: Date) -> String {
    let parts = Calendar.current.dateComponents([ .year, .month, .day, .hour, .minute, .second ], from: date)
    return String(
      format: "%04d-%02d-%02d %02d:%02d:%02d",
      parts.year ?? 0, parts.month ?? 0, parts.day ?? 0,
      parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0
    )
  }

  /// The take's length; the one being recorded counts up.
  static func length(of recording: RecordingListing, now: Date) -> String {
    let end = recording.endedAt?.date ?? now
    let seconds = max(0, Int(end.timeIntervalSince(recording.startedAt.date)))
    return String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
  }
}
