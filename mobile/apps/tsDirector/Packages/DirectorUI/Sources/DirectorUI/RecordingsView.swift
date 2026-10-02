import DirectorCore
import DirectorDVR
import TeamStationKit
import SwiftUI

/// Browse past recordings and AirDrop the chosen cameras plus the programme master.
public struct RecordingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var recordings: [RecordingSummary] = []
  @State private var selectedID: Int64?
  @State private var markedIDs: Set<Int64> = []
  @State private var selectedProgram = true
  @State private var selectedCameras: Set<String> = []
  @State private var showDeleteConfirm = false
  @State private var showReuseConfirm = false
  @State private var showEventPicker = false
  @State private var pendingReuse: (recording: RecordingSummary, cameras: [(SourceID, String)], includeProgram: Bool)?

  public init() {}

  public var body: some View {
    @Bindable var environment = environment
    NavigationStack {
      ZStack {
        HStack(spacing: 0) {
          // Select All and Delete sit over the takes they act on, below the title bar.
          VStack(spacing: 0) {
            HStack {
              Button(allEligibleMarked ? "Deselect All" : "Select All") {
                toggleSelectAll()
              }
              .disabled(eligibleIDs.isEmpty)
              .accessibilityIdentifier("recordings-select-all")
              Spacer()
              Button("Delete", role: .destructive) {
                showDeleteConfirm = true
              }
              .disabled(markedIDs.isEmpty)
              .accessibilityIdentifier("recordings-delete")
            }
            .font(.system(size: 15, weight: .semibold))
            .buttonStyle(.borderless)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()
            dateColumn
          }
          .frame(minWidth: 280, maxWidth: 360)
          Divider()
          filesColumn
        }
        .background(Color.deckBackground)

        if environment.isExporting {
          exportProgress
        }
        if showDeleteConfirm {
          deleteConfirm
        }
        if showReuseConfirm {
          reuseConfirm
        }
      }
      .navigationTitle("Recordings")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        ModalActionFooter(
          primaryTitle: "DONE",
          primaryIdentifier: "recordings-done",
          action: {
            environment.activeSheet = nil
            dismiss()
          }
        )
      }
      .onAppear { reload() }
      .onChange(of: selectedID) { _, _ in
        selectAll(in: selectedRecording)
      }
    }
    // AirDrop has to be presented from inside this full-screen cover. A share sheet asked for
    // on the root view queues behind the cover and only appears once DONE dismisses it.
    .sheet(isPresented: $showEventPicker) {
      if let recording = selectedRecording {
        EventPickerSheet(
          title: "Upload to which game?",
          onChoose: { event in
            showEventPicker = false
            upload(recording, to: event)
          },
          onCancel: { showEventPicker = false }
        )
      }
    }
    .sheet(isPresented: $environment.isSharingRecordings) {
      ShareSheet(urls: environment.lastRecordingShare)
    }
  }

  private var dateColumn: some View {
    List {
      ForEach(Array(recordings.enumerated()), id: \.element.id) { index, recording in
        let live = recording.id == environment.activeRecordingID
        HStack(alignment: .center, spacing: 12) {
          Button {
            toggleMarked(recording.id)
          } label: {
            Image(systemName: markedIDs.contains(recording.id) ? "circle.inset.filled" : "circle")
          }
          .buttonStyle(.borderless)
          .disabled(live)
          .accessibilityLabel("Select \(dateLabel(recording.startedAt))")
          .accessibilityIdentifier("recordings-select-\(index + 1)")
          .accessibilityValue(markedIDs.contains(recording.id) ? "selected" : "unselected")

          Button {
            selectedID = recording.id
          } label: {
            VStack(alignment: .leading, spacing: 4) {
              Text(dateLabel(recording.startedAt))
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(.primary)
              Text(lengthLabel(recording, live: live))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("recording-row-\(recording.id)")
        }
        .listRowBackground(
          selectedID == recording.id ? Color.white.opacity(0.12) : Color.clear
        )
      }
    }
    .listStyle(.plain)
    .frame(minWidth: 280, maxWidth: 360)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("recordings-dates")
  }

  private var filesColumn: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let recording = selectedRecording {
        List {
          if recording.programFilename != nil {
            Toggle("Primary output", isOn: $selectedProgram)
              .accessibilityIdentifier("recording-file-program")
          }
          ForEach(recording.sourceIDs, id: \.rawValue) { sourceID in
            let name = environment.recordingCameraName(for: sourceID, in: recording.id)
            Toggle(name, isOn: cameraBinding(sourceID))
              .accessibilityIdentifier("recording-file-\(sourceID.slug)")
          }
        }
        .listStyle(.plain)
        .id(recording.id)

        Button {
          export(recording)
        } label: {
          Text("EXPORT")
            .font(.system(size: 13, weight: .heavy, design: .rounded))
            .tracking(1)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(canExport(recording) ? Color.programGreen : Color.white.opacity(0.12))
            .foregroundStyle(canExport(recording) ? .black : .white.opacity(0.35))
        }
        .buttonStyle(.plain)
        .disabled(!canExport(recording) || environment.isExporting)
        .accessibilityIdentifier("recordings-export")
        .padding(.horizontal, 16)
        .padding(.top, 16)

        Button {
          // A take that was streamed to a game goes straight there. The list
          // exists for the take that was not — a bare RTSP publish, or a
          // recording made with no stream at all.
          if let game = recording.gameId {
            upload(
              recording,
              gameId: game,
              title: recording.gameTitle ?? dateLabel(recording.startedAt)
            )
          } else {
            showEventPicker = true
          }
        } label: {
          Text(uploadLabel(recording))
            .font(.system(size: 13, weight: .heavy, design: .rounded))
            .tracking(1)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(canExport(recording) ? Color.white.opacity(0.14) : Color.white.opacity(0.06))
            .foregroundStyle(canExport(recording) ? .white : .white.opacity(0.35))
        }
        .buttonStyle(.plain)
        .disabled(!canExport(recording) || environment.isExporting)
        .accessibilityIdentifier("recordings-upload")
        .padding(16)
      } else {
        Text(recordings.isEmpty ? "No recordings yet" : "Choose a recording")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityIdentifier("recordings-empty")
      }
    }
  }

  private var deleteConfirm: some View {
    let count = markedIDs.count
    return ZStack {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture { showDeleteConfirm = false }
      VStack(spacing: 14) {
        Text(count == 1 ? "Delete 1 recording?" : "Delete \(count) recordings?")
          .font(.system(size: 17, weight: .bold, design: .rounded))
          .foregroundStyle(.white)
        Text("Deleted takes are removed from the list and from disk.")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(.white.opacity(0.7))
          .multilineTextAlignment(.center)
        Button {
          deleteMarked()
          showDeleteConfirm = false
        } label: {
          Text("Delete")
            .font(.system(size: 17, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color.recordRed, in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("recordings-delete-confirm")
        Button("Cancel") { showDeleteConfirm = false }
          .font(.system(size: 15, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.65))
      }
      .padding(28)
      .frame(width: 320)
      .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 16))
    }
  }

  private var reuseConfirm: some View {
    ZStack {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture { cancelReuse() }
      VStack(spacing: 14) {
        Text("Processed files already exist")
          .font(.system(size: 17, weight: .bold, design: .rounded))
          .foregroundStyle(.white)
          .multilineTextAlignment(.center)
        Text("Export the existing movies, or remux from the originals again.")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(.white.opacity(0.7))
          .multilineTextAlignment(.center)
        Button {
          finishReuse(reprocess: false)
        } label: {
          Text("Export")
            .font(.system(size: 17, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color.programGreen, in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(.black)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("recordings-export-existing")
        Button {
          finishReuse(reprocess: true)
        } label: {
          Text("Reprocess")
            .font(.system(size: 17, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("recordings-export-reprocess")
        Button("Cancel") { cancelReuse() }
          .font(.system(size: 15, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.65))
          .accessibilityIdentifier("recordings-export-reuse-cancel")
      }
      .padding(28)
      .frame(width: 320)
      .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 16))
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("recordings-export-reuse")
  }

  private var exportProgress: some View {
    ZStack {
      Color.black.opacity(0.72)
        .ignoresSafeArea()
      VStack(alignment: .leading, spacing: 16) {
        Text("Preparing export")
          .font(.system(size: 18, weight: .bold, design: .rounded))
          .foregroundStyle(.white)
        ForEach(environment.exportItems) { item in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(item.name)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
              Spacer()
              Text("\(Int((item.fraction * 100).rounded()))%")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.7))
            }
            GeometryReader { geo in
              ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule()
                  .fill(Color.programGreen)
                  .frame(width: max(0, geo.size.width * item.fraction))
              }
            }
            .frame(height: 8)
          }
        }
      }
      .padding(24)
      .frame(maxWidth: 480)
      .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 12))
    }
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isModal)
    .accessibilityIdentifier("export-progress")
    .accessibilityLabel("Preparing export")
  }

  private var selectedRecording: RecordingSummary? {
    recordings.first { $0.id == selectedID }
  }

  private var eligibleIDs: [Int64] {
    recordings.filter { $0.id != environment.activeRecordingID }.map(\.id)
  }

  private var allEligibleMarked: Bool {
    !eligibleIDs.isEmpty && Set(eligibleIDs).isSubset(of: markedIDs)
  }

  private func reload() {
    recordings = environment.listedRecordings()
    markedIDs.formIntersection(Set(eligibleIDs))
    if selectedID == nil || !recordings.contains(where: { $0.id == selectedID }) {
      selectedID = recordings.first?.id
    }
    selectAll(in: selectedRecording)
  }

  private func toggleSelectAll() {
    if allEligibleMarked {
      markedIDs.removeAll()
    } else {
      markedIDs = Set(eligibleIDs)
    }
  }

  private func toggleMarked(_ id: Int64) {
    guard id != environment.activeRecordingID else { return }
    if markedIDs.contains(id) {
      markedIDs.remove(id)
    } else {
      markedIDs.insert(id)
    }
  }

  private func deleteMarked() {
    let ids = Array(markedIDs)
    environment.deleteRecordings(ids: ids)
    markedIDs.removeAll()
    reload()
  }

  private func selectAll(in recording: RecordingSummary?) {
    selectedProgram = recording?.programFilename != nil
    selectedCameras = Set((recording?.sourceIDs ?? []).map(\.rawValue))
  }

  private func cameraBinding(_ sourceID: SourceID) -> Binding<Bool> {
    Binding(
      get: { selectedCameras.contains(sourceID.rawValue) },
      set: { on in
        if on { selectedCameras.insert(sourceID.rawValue) }
        else { selectedCameras.remove(sourceID.rawValue) }
      }
    )
  }

  private func canExport(_ recording: RecordingSummary) -> Bool {
    (selectedProgram && recording.programFilename != nil) || !selectedCameras.isEmpty
  }

  private func export(_ recording: RecordingSummary) {
    let cameras = recording.sourceIDs
      .filter { selectedCameras.contains($0.rawValue) }
      .map { ($0, environment.recordingCameraName(for: $0, in: recording.id)) }
    let includeProgram = selectedProgram && recording.programFilename != nil
    if environment.hasPreparedExport(recording, cameras: cameras, includeProgram: includeProgram) {
      pendingReuse = (recording, cameras, includeProgram)
      showReuseConfirm = true
      return
    }
    environment.shareRecording(
      recording,
      cameras: cameras,
      includeProgram: includeProgram
    )
  }

  /// What the button says: the upload's own progress once one is running.
  ///
  /// A take that knows its game says so. There is no picker to confirm
  /// against on that path, so the name of the game has to be on the button
  /// somebody is about to press.
  private func uploadLabel(_ recording: RecordingSummary) -> String {
    guard let upload = environment.teamStation.uploads[recording.id] else {
      guard recording.gameId != nil, let game = recording.gameTitle else {
        return "UPLOAD TO TEAMSTATION"
      }
      return "UPLOAD TO \(withoutDate(game).uppercased())"
    }
    if upload.failed != nil { return "UPLOAD FAILED — TRY AGAIN" }
    if upload.done { return "UPLOADED" }
    // Once the bytes are up the server has minutes of work left, and a
    // percentage that sits at 100 for four of them reads as a hang. The
    // account turns the server's own word for what it is doing into a
    // sentence; this only has to shout it.
    return upload.saying.uppercased()
  }

  private func upload(_ recording: RecordingSummary, to event: TeamStationEvent) {
    let day = ISO8601DateFormatter()
    day.formatOptions = [.withFullDate]
    upload(
      recording,
      gameId: event.gameId,
      title: "\(day.string(from: event.startAt)) \(event.title)"
    )
  }

  /// Sends whatever is ticked, to the game named.
  ///
  /// The tracks come from the tick boxes rather than from what is on disk,
  /// which is the same rule the export button follows: the operator chose
  /// these, and an upload that quietly sends a camera nobody ticked is a
  /// surprise on a connection that cannot afford one.
  private func upload(_ recording: RecordingSummary, gameId: String, title: String) {
    let cameras = recording.sourceIDs
      .filter { selectedCameras.contains($0.rawValue) }
      .map { ($0, environment.recordingCameraName(for: $0, in: recording.id)) }
    let includeProgram = selectedProgram && recording.programFilename != nil
    environment.uploadRecording(
      recording,
      cameras: cameras,
      includeProgram: includeProgram,
      gameId: gameId,
      title: title
    )
  }

  /// A title with its `YYYY-MM-DD ` prefix taken off. The date is already in
  /// the row above the button; repeating it on the button costs the room the
  /// game's name needs.
  private func withoutDate(_ title: String) -> String {
    title.replacingOccurrences(
      of: "^\\d{4}-\\d{2}-\\d{2}\\s*", with: "", options: .regularExpression
    )
  }

  private func cancelReuse() {
    pendingReuse = nil
    showReuseConfirm = false
  }

  private func finishReuse(reprocess: Bool) {
    guard let pending = pendingReuse else { return }
    cancelReuse()
    environment.shareRecording(
      pending.recording,
      cameras: pending.cameras,
      includeProgram: pending.includeProgram,
      reprocess: reprocess
    )
  }

  private func dateLabel(_ wall: WallClock) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return formatter.string(from: wall.date)
  }

  /// Only the take that is actually rolling counts up. A take the app never closed has a real
  /// length, taken from the segments it wrote; giving it a running clock is how a 74-minute
  /// recording came to read as six hours in this list.
  private func lengthLabel(_ recording: RecordingSummary, live: Bool) -> String {
    let seconds = live
      ? max(0, Date().timeIntervalSince1970 - recording.startedAt.seconds)
      : max(0, recording.duration)
    let minutes = Int(seconds) / 60
    let remainder = Int(seconds) % 60
    if minutes >= 60 {
      return String(format: "%d:%02d:%02d", minutes / 60, minutes % 60, remainder)
    }
    return String(format: "%d:%02d", minutes, remainder)
  }
}
