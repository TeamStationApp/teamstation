import Foundation
import DirectorCore

/// What an export of one recording reads from the index, in a form that can travel to another
/// machine.
///
/// GS Distributor stitches some of an export's files on the Mac with the same `ExportService` the
/// iPad runs. The Mac does not get a copy of `index.sqlite`: a copy taken without its WAL is a
/// stale snapshot, and it would carry every other take along with it. It gets this instead: the
/// recording's own row, the segment rows of the cameras it is stitching, and the programme's
/// anchors. `ArchiveIndex.importManifest` loads them into an empty index, and the export reads it
/// exactly as it reads the iPad's.
public struct RecordingManifest: Sendable, Equatable, Codable {
  public var recordingID: Int64
  public var startedAt: WallClock
  public var endedAt: WallClock?
  public var programFilename: String?
  /// Every segment row of the chosen cameras, initialisation segments included, ids kept.
  public var segments: [SegmentRecord]
  public var programAnchors: [ArchiveIndex.ProgramAnchor]
  /// The encoding the take was recorded with, so the Mac encodes its exports the way the iPad would.
  /// Absent from an iPad that predates it, and from a take recorded before it was kept.
  public var encoding: TakeEncoding? = nil
}
