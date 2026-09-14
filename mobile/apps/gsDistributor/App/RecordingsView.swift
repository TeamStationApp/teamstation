import DirectorCore
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
    } else {
      ContentUnavailableView("Choose a recording", systemImage: "film.stack")
    }
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
