import DistributorWire
import Foundation

/// What of one recording's export is already in this Mac's folder, read from the disk alone. It
/// needs nothing from the iPad, so it can be shown, and acted on, while TS Director records.
public struct ExportInventory: Equatable, Sendable {
  public enum FileState: Equatable, Sendable {
    /// Whole, under its final name.
    case saved(bytes: Int64)
    /// Cut off part way: a download resumes from it; a combined video is made again.
    case interrupted(bytes: Int64)
    case missing

    public var isSaved: Bool {
      if case .saved = self { return true }
      return false
    }
  }

  /// Each file the recording has: its primary output, if it has one, and its cameras.
  public let files: [Track: FileState]
  public let combined: FileState
  /// The files whose segments are kept on this Mac, so they can be stitched again without the iPad.
  public let segmentsOnMac: Set<Track>

  public init(recording: RecordingListing, destination: URL) {
    let folder = DistributionRun.folder(for: recording, in: destination)
    let tracks = (recording.hasPrimary ? [ Track.primary ] : []) + recording.cameras.map { Track.camera($0.sourceID) }
    var files: [Track: FileState] = [:]
    for track in tracks {
      let file = folder.appendingPathComponent(DistributionRun.filename(for: track, of: recording))
      // A download keeps what has arrived beside the file until the whole of it is in.
      files[track] = Self.state(of: file, cutOff: file.appendingPathExtension("partial"))
    }
    self.files = files
    segmentsOnMac = KeptSegments.tracks(of: recording, in: destination)
    let name = DistributionRun.combinedFilename(of: recording)
    combined = Self.state(
      of: folder.appendingPathComponent(name),
      cutOff: folder.appendingPathComponent(name + ".partial.mov")
    )
  }

  /// Whether exporting `tracks` needs the iPad: a file not yet whole here, or reprocessed, has to
  /// be stitched again from its segments, which come from the iPad unless they are kept here.
  public func needsIPad(_ tracks: [Track], reprocess: Bool = false) -> Bool {
    tracks.contains { track in
      !segmentsOnMac.contains(track) && (reprocess || !(files[track]?.isSaved ?? false))
    }
  }

  static func state(of file: URL, cutOff: URL) -> FileState {
    let whole = DistributionRun.size(of: file)
    if whole > 0 { return .saved(bytes: whole) }
    guard FileManager.default.fileExists(atPath: cutOff.path) else { return .missing }
    return .interrupted(bytes: DistributionRun.size(of: cutOff))
  }
}
