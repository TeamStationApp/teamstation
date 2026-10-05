import AppKit
import Distribution
import DistributorWire
import SwiftUI

/// Each file of an export as it goes: where it is being stitched, how far along, and where it
/// landed.
struct ExportProgressView: View {
  let run: DistributionRun
  let done: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(run.isFinished ? (run.wasCancelled ? "Export cancelled" : "Export finished") : "Exporting")
        .font(.title2.bold())
      Text(run.folder.path)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.middle)

      ForEach(run.tracks, id: \.self) { track in
        row(track)
      }
      if let state = run.combinedState {
        row(label: run.combinedSound.map { "Combined video, sound from \($0)" } ?? "Combined video", state: state)
      }
      if let upload = run.teamStation {
        Divider()
        Text("TeamStation")
          .font(.headline)
        ForEach(upload.tracks, id: \.self) { track in
          uploadRow(title: upload.title(for: track), state: run.uploadStates[track] ?? .queued)
        }
      }

      HStack {
        if run.isFinished, !savedFiles.isEmpty {
          Button("Show in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting(savedFiles)
          }
        }
        Spacer()
        if !run.isFinished {
          Button("Cancel Export", role: .cancel) { run.cancel() }
            .disabled(run.wasCancelled)
            .accessibilityIdentifier("export-cancel")
        }
        Button("Done") { done() }
          .keyboardShortcut(.defaultAction)
          .disabled(!run.isFinished)
          .accessibilityIdentifier("export-done")
      }
    }
    .padding(24)
    .frame(width: 580)
  }

  private var savedFiles: [URL] {
    var files = run.tracks.compactMap { track -> URL? in
      if case .done(let url) = run.states[track] { return url }
      return nil
    }
    if case .done(let url) = run.combinedState { files.append(url) }
    return files
  }

  private func label(_ track: Track) -> String {
    switch track {
    case .primary:
      return "Primary output"
    case .camera(let sourceID):
      return run.recording.cameras.first { $0.sourceID == sourceID }?.name ?? sourceID.rawValue
    }
  }

  private func row(_ track: Track) -> some View {
    row(label: label(track), state: run.states[track] ?? .queued)
  }

  @ViewBuilder
  private func row(label: String, state: TrackState) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(label).font(.headline)
        Spacer()
        Text(status(state))
          .font(.callout)
          .foregroundStyle(isFailure(state) ? Color.red : Color.secondary)
      }
      if let fraction = fraction(state) {
        ProgressView(value: fraction)
      } else if !state.isFinal {
        ProgressView().progressViewStyle(.linear)
      }
    }
    .accessibilityIdentifier("export-row-\(label)")
  }

  /// One video on its way to TeamStation, named by its title.
  @ViewBuilder
  private func uploadRow(title: String, state: UploadState) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(title)
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer()
        Group {
          switch state {
          case .queued:
            Text("Waiting to upload")
          case let .uploading(sent, total):
            Text("Uploading, \(Self.megabytes(sent)) of \(Self.megabytes(total))")
          case .finishing(let step):
            Text(Self.saying(step))
          case .done:
            Text("Uploaded")
          case .failed(let reason):
            Text(reason).foregroundStyle(.red)
          }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
      }
      if case let .uploading(sent, total) = state, total > 0 {
        ProgressView(value: min(1, Double(sent) / Double(total)))
      }
      // No fraction to show while the server works, and a full bar would
      // read as stuck, so it spins instead.
      if case .finishing = state {
        ProgressView().progressViewStyle(.linear)
      }
    }
    .accessibilityIdentifier("upload-row-\(title)")
  }

  private func status(_ state: TrackState) -> String {
    switch state {
    case .queued:
      return "Waiting"
    case let .fetching(received, total):
      return "Fetching, \(Self.megabytes(received)) of \(Self.megabytes(total))"
    case .fetched:
      return "Off the iPad, waiting to be stitched"
    case .stitching:
      return "Stitching"
    case let .downloading(received, _):
      return "Downloading from the iPad, \(Self.megabytes(received))"
    case .done:
      return "Saved"
    case .failed(let reason):
      return reason
    }
  }

  private func fraction(_ state: TrackState) -> Double? {
    switch state {
    case let .fetching(received, total) where total > 0:
      return min(1, Double(received) / Double(total))
    case let .stitching(fraction):
      return fraction
    case let .downloading(received, total) where total > 0:
      return min(1, Double(received) / Double(total))
    case .done:
      return 1
    default:
      return nil
    }
  }

  private func isFailure(_ state: TrackState) -> Bool {
    if case .failed = state { return true }
    return false
  }

  /// The server's word for what it is doing, in words for a person.
  static func saying(_ step: String) -> String {
    switch step {
    case "assembling": return "Putting the parts together…"
    case "probing": return "Reading the recording…"
    case "remuxing": return "Converting…"
    case "uploading": return "Copying to the library…"
    case "writing": return "Nearly there…"
    default: return "Working…"
    }
  }

  private static func megabytes(_ bytes: Int64) -> String {
    String(format: "%.0f MB", Double(max(0, bytes)) / 1_000_000)
  }
}
