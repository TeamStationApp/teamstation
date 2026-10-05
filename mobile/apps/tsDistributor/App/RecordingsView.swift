import DirectorCore
import Distribution
import DistributorWire
import SwiftUI

/// The iPad's recordings, laid out like TS Director's Recordings screen: the takes on the left,
/// marked for deletion with a circle, and the chosen take's files on the right.
struct RecordingsView: View {
  let model: DistributorModel

  @State private var selectedID: Int64?
  @State private var marked: Set<Int64> = []
  @State private var confirmingDelete = false
  @State private var includesPrimary = true
  @State private var includedCameras: Set<String> = []
  @State private var step: ExportStep?
  /// Stitch every ticked file again from the recording, rather than use the files already on this
  /// Mac or prepared on the iPad.
  @State private var reprocess = false

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
      Text("Their camera files, primary output and prepared exports are removed from TS Director.")
    }
    .onChange(of: model.recordings) { _, recordings in
      let present = Set(recordings.map(\.id))
      marked.formIntersection(present.subtracting(recordings.filter(\.isLive).map(\.id)))
      if let selectedID, !present.contains(selectedID) { self.selectedID = nil }
    }
    .onChange(of: selectedID) { _, _ in
      includesPrimary = true
      includedCameras = Set(selected?.cameras.map(\.sourceID.rawValue) ?? [])
      reprocess = false
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
            // The game TS Director recorded it for, which its uploads go to.
            if let game = recording.gameTitle {
              Text(game)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.tail)
                .accessibilityIdentifier("recording-game-\(recording.id)")
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
              Text(Self.length(of: recording, now: context.date))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
          }
          Spacer()
          // A master whose sound falls short of its picture is the one fault nothing downstream can
          // repair, so it is said here, before anybody chooses to export or upload the take. Takes
          // 413 and 414 were 43.9 s and 46.8 s short and went out anyway.
          if let short = recording.soundShortfall, short > 0.25 {
            Label(Self.describeShortfall(short), systemImage: "speaker.slash.fill")
              .font(.caption.bold())
              .foregroundStyle(.orange)
              .help("The programme master's sound is \(Self.describeShortfall(short)) shorter than "
                + "its picture, so it drifts further ahead as the take goes on. The camera "
                + "archives are unaffected.")
              .accessibilityIdentifier("recording-sound-short-\(recording.id)")
          }
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

  /// Seconds, or minutes and seconds once it is long enough that seconds alone read as small.
  static func describeShortfall(_ seconds: Double) -> String {
    guard seconds >= 60 else { return String(format: "%.1f s", seconds) }
    return String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
  }

  // MARK: - Files

  private var selected: RecordingListing? {
    model.recordings.first { $0.id == selectedID }
  }

  /// The take's files with where each one is, so a cut-off export can be picked up from what is
  /// already on this Mac: files here need nothing from the iPad.
  @ViewBuilder
  private var filesColumn: some View {
    if let recording = selected {
      let inventory = model.inventory(of: recording)
      let chosen = chosenTracks(recording)
      let needsIPad = inventory?.needsIPad(chosen, reprocess: reprocess) ?? true
      List {
        if recording.hasPrimary {
          Toggle(isOn: $includesPrimary) { fileLabel("Primary output", inventory?.files[.primary]) }
            .accessibilityIdentifier("recording-file-program")
        }
        ForEach(recording.cameras, id: \.sourceID.rawValue) { camera in
          Toggle(isOn: cameraBinding(camera.sourceID)) {
            fileLabel(camera.name, inventory?.files[.camera(camera.sourceID)])
          }
          .accessibilityIdentifier("recording-file-\(camera.sourceID.slug)")
        }
        if let combined = inventory?.combined, combined != .missing || model.settings.createCombined {
          LabeledContent("Combined video") {
            Text(Self.describeCombined(combined))
              .foregroundStyle(.secondary)
          }
          .accessibilityIdentifier("recording-combined-state")
        }
        Toggle(isOn: $reprocess) {
          VStack(alignment: .leading, spacing: 1) {
            Text("Stitch again")
            Text("From the recording, not the files already on this Mac or prepared on the iPad")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .accessibilityIdentifier("recording-reprocess")
      }
      .id(recording.id)
      .safeAreaInset(edge: .bottom) {
        HStack {
          if recording.isLive {
            Text("This take is still being recorded.")
              .foregroundStyle(.secondary)
          } else if let reason = model.exportBlockedReason {
            Text(needsIPad
              ? "\(reason) Untick the files not yet on this Mac to combine and upload the rest."
              : "Every ticked file is on this Mac, so this runs on the Mac alone.")
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("recordings-export-blocked")
          }
          Spacer()
          Button("Export") { startExport(recording) }
            .keyboardShortcut(.defaultAction)
            .disabled(
              recording.isLive || chosen.isEmpty || model.isExporting
                || (model.exportBlockedReason != nil && needsIPad)
            )
            .accessibilityIdentifier("recordings-export")
        }
        .padding(12)
        .background(.bar)
        .sheet(item: $step) { step in
          switch step {
          case let .combine(recording, tracks, candidates):
            CombinedSheet(
              recording: recording,
              candidates: candidates,
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
              onContinue: { teamStation in
                self.step = nil
                model.export(
                  recording,
                  tracks: tracks,
                  reprocess: reprocess,
                  combined: combined,
                  teamStation: teamStation
                )
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
    case combine(recording: RecordingListing, tracks: [Track], candidates: [CombinedCandidate])
    /// The game it belongs to and which files go up.
    case upload(recording: RecordingListing, tracks: [Track], combined: CombinedPlan?)

    var id: String {
      switch self {
      case .combine: "combine"
      case .upload: "upload"
      }
    }
  }

  /// With a combined video on and two or more files ticked that it can take (cameras, and the
  /// primary output), the layout comes first; then the game and the files to
  /// send; then the export starts.
  private func startExport(_ recording: RecordingListing) {
    let tracks = chosenTracks(recording)
    let candidates = CombinedCandidate.all(for: recording, tracks: tracks)
    if model.settings.createCombined, candidates.count >= 2 {
      step = .combine(recording: recording, tracks: tracks, candidates: candidates)
    } else {
      proceed(recording, tracks: tracks, combined: nil)
    }
  }

  /// The upload sheet always comes next: it is where the game is chosen, and
  /// it is also where an export that only saves files is started from, so the
  /// choice between the two is made in one place rather than in the settings.
  private func proceed(_ recording: RecordingListing, tracks: [Track], combined: CombinedPlan?) {
    step = .upload(recording: recording, tracks: tracks, combined: combined)
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

  private func fileLabel(_ name: String, _ state: ExportInventory.FileState?) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(name)
      if let state {
        Text(Self.describe(state))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  static func describe(_ state: ExportInventory.FileState) -> String {
    switch state {
    case .saved(let bytes): "On this Mac, \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))"
    case .interrupted: "Partly downloaded; the rest comes from the iPad"
    case .missing: "On the iPad"
    }
  }

  static func describeCombined(_ state: ExportInventory.FileState) -> String {
    switch state {
    case .saved(let bytes): "On this Mac, \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))"
    case .interrupted: "Cut off; made again from the saved files"
    case .missing: "Not made yet"
    }
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
