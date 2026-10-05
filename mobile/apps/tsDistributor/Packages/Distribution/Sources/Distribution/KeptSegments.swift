import DistributorWire
import Foundation

/// A take's segments, kept on this Mac once they are off the iPad, so any of its files can be
/// stitched again with no iPad attached.
///
/// In `<day>/.tsDistributor-segments/<recording>/`, beside the take's files on the disk they are
/// saved to: one folder per file, laid out as the iPad lays its own out (`index.sqlite` beside
/// `Archives/`, `Program/` and `Prepared/`), with the manifest the files were fetched with. That
/// manifest is written last, so a folder without one is a fetch that never finished, and goes.
public enum KeptSegments {
  /// Hidden, so it is never taken for one of the files.
  public static let folderName = ".tsDistributor-segments"
  static let manifestName = "manifest.json"

  /// Where `recording`'s segments are kept.
  public static func folder(for recording: RecordingListing, in destination: URL) -> URL {
    DistributionRun.folder(for: recording, in: destination)
      .appendingPathComponent(folderName, isDirectory: true)
      .appendingPathComponent(String(recording.id), isDirectory: true)
  }

  /// Where the segments `track` is stitched from are kept, within a take's folder.
  static func folder(for track: Track, in take: URL) -> URL {
    let name = switch track {
    case .primary: "primary"
    case .camera(let sourceID): "camera-\(sourceID.slug)"
    }
    return take.appendingPathComponent(name, isDirectory: true)
  }

  /// The files of `recording` whose segments are all here.
  public static func tracks(of recording: RecordingListing, in destination: URL) -> Set<Track> {
    let take = folder(for: recording, in: destination)
    let every = (recording.hasPrimary ? [ Track.primary ] : []) + recording.cameras.map { Track.camera($0.sourceID) }
    return Set(every.filter { isComplete(folder(for: $0, in: take)) })
  }

  /// Marks a fetch into `root` whole, by writing the manifest it was fetched with.
  static func complete(_ root: URL, response: ManifestResponse) throws {
    try JSONEncoder().encode(response).write(to: root.appendingPathComponent(manifestName), options: .atomic)
  }

  static func isComplete(_ root: URL) -> Bool {
    FileManager.default.fileExists(atPath: root.appendingPathComponent(manifestName).path)
  }

  /// `track`'s kept segments, ready to stitch; nil when they are not all here.
  static func fetched(_ track: Track, in take: URL) -> MacStitcher.Fetched? {
    let root = folder(for: track, in: take)
    guard let data = try? Data(contentsOf: root.appendingPathComponent(manifestName)),
          let response = try? JSONDecoder().decode(ManifestResponse.self, from: data)
    else { return nil }
    return MacStitcher.Fetched(track: track, root: root, response: response)
  }

  /// Removes what a fetch that never finished left in `take`, and `take` itself when nothing is
  /// left in it.
  static func removeIncomplete(in take: URL) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: take.path)) ?? []
    for name in names {
      let root = take.appendingPathComponent(name, isDirectory: true)
      if !isComplete(root) { try? FileManager.default.removeItem(at: root) }
    }
    removeIfEmpty(take)
    removeIfEmpty(take.deletingLastPathComponent())
  }

  private static func removeIfEmpty(_ folder: URL) {
    if let left = try? FileManager.default.contentsOfDirectory(atPath: folder.path), left.isEmpty {
      try? FileManager.default.removeItem(at: folder)
    }
  }

  public enum Removal: Equatable, Sendable {
    /// Gone, and how many bytes that gave back.
    case removed(bytes: Int64)
    /// There were none.
    case none
    /// A run is using them; nothing was removed.
    case inUse
  }

  /// Removes `recording`'s kept segments, unless `batch` (the run under way) is exporting it.
  @MainActor
  public static func remove(
    _ recording: RecordingListing,
    in destination: URL,
    unlessUsedBy batch: DistributionBatch?
  ) throws -> Removal {
    if let batch, !batch.isFinished, batch.runs.contains(where: { $0.recording.id == recording.id }) {
      return .inUse
    }
    let take = folder(for: recording, in: destination)
    guard FileManager.default.fileExists(atPath: take.path) else { return .none }
    let bytes = size(of: take)
    try FileManager.default.removeItem(at: take)
    removeIfEmpty(take.deletingLastPathComponent())
    return .removed(bytes: bytes)
  }

  /// What every file under `folder` comes to.
  static func size(of folder: URL) -> Int64 {
    guard let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [ .fileSizeKey ]) else { return 0 }
    var total: Int64 = 0
    for case let url as URL in walk {
      total += Int64((try? url.resourceValues(forKeys: [ .fileSizeKey ]).fileSize) ?? 0)
    }
    return total
  }
}
