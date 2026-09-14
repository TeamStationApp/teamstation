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
      if let upload = run.upload {
        Divider()
        Text("PeerTube")
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

  /// One video on its way to PeerTube, named by its title.
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
          case .done(let page):
            if let page { Link("Uploaded", destination: page) } else { Text("Uploaded") }
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
    }
    .accessibilityIdentifier("upload-row-\(title)")
  }

  private func status(_ state: TrackState) -> String {
    switch state {
    case .queued:
      return "Waiting"
    case let .fetching(_, received, total):
      return "Fetching for the Mac, \(Self.megabytes(received)) of \(Self.megabytes(total))"
    case let .stitching(worker, _):
      return worker == .mac ? "Stitching on the Mac" : "Stitching on the iPad"
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
    case let .fetching(_, received, total) where total > 0:
      return min(1, Double(received) / Double(total))
    case let .stitching(_, fraction):
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

  private static func megabytes(_ bytes: Int64) -> String {
    String(format: "%.0f MB", Double(max(0, bytes)) / 1_000_000)
  }
}
