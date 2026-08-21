import DirectorCore
import DirectorDVR
import SwiftUI

/// Browse past recordings and AirDrop the chosen cameras plus the programme master.
public struct RecordingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var recordings: [RecordingSummary] = []
  @State private var selectedID: Int64?
  @State private var selectedProgram = true
  @State private var selectedCameras: Set<String> = []
  @State private var showExportProgress = false

  public init() {}

  public var body: some View {
    NavigationStack {
      ZStack {
        HStack(spacing: 0) {
          dateColumn
          Divider()
          filesColumn
        }
        .background(Color.deckBackground)

        if showExportProgress || environment.isExporting {
          exportProgress
        }
      }
      .navigationTitle("Recordings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            environment.activeSheet = nil
            dismiss()
          }
          .accessibilityIdentifier("recordings-done")
        }
      }
      .onAppear {
        recordings = environment.listedRecordings()
        if selectedID == nil { selectedID = recordings.first?.id }
        selectAll(in: selectedRecording)
      }
      .onChange(of: environment.isSharingRecordings) { _, sharing in
        if sharing { showExportProgress = false }
      }
      .onChange(of: environment.isExporting) { _, exporting in
        if exporting { showExportProgress = true }
        if !exporting && environment.lastRecordingShare.isEmpty {
          showExportProgress = false
        }
      }
    }
  }

  private var dateColumn: some View {
    List {
      ForEach(recordings) { recording in
        Button {
          selectedID = recording.id
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(dateLabel(recording.startedAt))
              .font(.system(size: 15, weight: .semibold, design: .monospaced))
              .foregroundStyle(.primary)
            Text(lengthLabel(recording))
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(.secondary)
          }
          .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .listRowBackground(
          selectedID == recording.id ? Color.white.opacity(0.12) : Color.clear
        )
        .accessibilityIdentifier("recording-row-\(recording.id)")
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
            let name = environment.recordingCameraName(for: sourceID)
            Toggle(name, isOn: cameraBinding(sourceID))
              .accessibilityIdentifier("recording-file-\(sourceID.slug)")
          }
        }
        .listStyle(.plain)
        .id(recording.id)

        Button {
          showExportProgress = true
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
      .map { ($0, environment.recordingCameraName(for: $0)) }
    environment.shareRecording(
      recording,
      cameras: cameras,
      includeProgram: selectedProgram && recording.programFilename != nil
    )
  }

  private func dateLabel(_ wall: WallClock) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return formatter.string(from: wall.date)
  }

  private func lengthLabel(_ recording: RecordingSummary) -> String {
    let seconds = max(0, recording.duration)
    let minutes = Int(seconds) / 60
    let remainder = Int(seconds) % 60
    if minutes >= 60 {
      return String(format: "%d:%02d:%02d", minutes / 60, minutes % 60, remainder)
    }
    return String(format: "%d:%02d", minutes, remainder)
  }
}
