import DirectorClient
import DirectorCore
import DirectorExport
import DistributorWire
import Foundation

/// Stitches one track on this Mac with TS Director's own `ExportService`.
///
/// In two steps, so an export can have everything off the iPad before it stitches anything: `fetch`
/// brings the index rows and the files the track reads into a work folder laid out as the iPad lays
/// them out; `stitch` loads the rows into a scratch index there and exports with the window the
/// whole export shares, so the file is the one the iPad would have made.
public struct MacStitcher: Sendable {
  public let connection: DirectorConnection
  public let scratch: URL
  public let parallelDownloads: Int

  public init(connection: DirectorConnection, scratch: URL, parallelDownloads: Int = 3) {
    self.connection = connection
    self.scratch = scratch
    self.parallelDownloads = parallelDownloads
  }

  /// The folder one stitch worked in, which can go once its file is saved elsewhere.
  public func workFolder(of url: URL) -> URL? {
    let base = scratch.standardizedFileURL.pathComponents
    let parts = url.standardizedFileURL.pathComponents
    guard parts.count > base.count, Array(parts.prefix(base.count)) == base else { return nil }
    return scratch.appendingPathComponent(parts[base.count], isDirectory: true)
  }

  public enum Stage: Sendable, Equatable {
    case fetching(received: Int64, total: Int64)
    case stitching(Double)
  }

  /// One track's files, fetched off the iPad into a folder of their own and laid out as the iPad
  /// lays them out. Stitching it needs nothing more from the iPad.
  public struct Fetched: Sendable {
    public let track: Track
    /// The work folder: everything the stitch reads, and where it writes.
    public let root: URL
    let response: ManifestResponse
  }

  /// Fetches the index rows and the files `track` reads into `root`, or a work folder of its own in
  /// `scratch`, and marks it whole by writing the manifest last (see `KeptSegments`).
  ///
  /// Cancelling the task stops the downloads where they are, and the folder goes with them: nothing
  /// of a cancelled or failed fetch is left behind.
  public func fetch(
    recording: RecordingListing,
    track: Track,
    into root: URL? = nil,
    progress: @escaping @Sendable (_ received: Int64, _ total: Int64) -> Void
  ) async throws -> Fetched {
    let response = try await connection.manifest(recordingID: recording.id, tracks: [ track ])
    let root = root ?? scratch.appendingPathComponent("stitch-\(UUID().uuidString)", isDirectory: true)
    // Whatever an earlier fetch left here is replaced whole, never mixed with this one.
    try? FileManager.default.removeItem(at: root)
    do {
      try await fetch(response.files, into: root, progress: progress)
      try Task.checkCancellation()
      try KeptSegments.complete(root, response: response)
      return Fetched(track: track, root: root, response: response)
    } catch {
      try? FileManager.default.removeItem(at: root)
      throw error
    }
  }

  /// Stitches a fetched track with the window the whole export shares, and returns the file, still
  /// inside the fetch's folder. It reads only this Mac's disk, so it carries on with the iPad gone,
  /// and leaves what it was stitched from as it was, so the track can be stitched from it again.
  public static func stitch(
    _ fetched: Fetched,
    recording: RecordingListing,
    window: ExportWindow,
    progress: @escaping @Sendable (Double) -> Void
  ) async throws -> URL {
    try await stitchFetched(fetched, recording: recording, window: window, progress: progress)
  }

  /// Fetches `track` and stitches it in one go, for a single file wanted at once.
  public func stitch(
    recording: RecordingListing,
    track: Track,
    window: ExportWindow,
    progress: @escaping @Sendable (Stage) -> Void
  ) async throws -> URL {
    let fetched = try await fetch(recording: recording, track: track) { received, total in
      progress(.fetching(received: received, total: total))
    }
    return try await Self.stitch(fetched, recording: recording, window: window) { progress(.stitching($0)) }
  }

  private static func folders(in root: URL) -> (archives: URL, program: URL, prepared: URL) {
    (
      root.appendingPathComponent("Archives", isDirectory: true),
      root.appendingPathComponent("Program", isDirectory: true),
      root.appendingPathComponent("Prepared", isDirectory: true)
    )
  }

  private func fetch(
    _ files: [RemoteFile],
    into root: URL,
    progress: @escaping @Sendable (Int64, Int64) -> Void
  ) async throws {
    let (archives, program, prepared) = Self.folders(in: root)
    for folder in [ archives, program, prepared ] {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    let tally = FetchTally(total: files.reduce(0) { $0 + $1.bytes }, report: progress)
    let connection = self.connection
    let width = max(1, parallelDownloads)
    try await withThrowingTaskGroup(of: Void.self) { group in
      var next = 0
      func start() {
        guard next < files.count else { return }
        let file = files[next]
        next += 1
        let base = file.root == .program ? program : (file.root == .prepared ? prepared : archives)
        let local = base.appendingPathComponent(file.path)
        group.addTask {
          try await connection.download(file, to: local) { received, _ in
            tally.update(file.path, received: received)
          }
        }
      }
      for _ in 0..<width { start() }
      while try await group.next() != nil { start() }
    }
  }

  private static func stitchFetched(
    _ fetched: Fetched,
    recording: RecordingListing,
    window: ExportWindow,
    progress: @escaping @Sendable (Double) -> Void
  ) async throws -> URL {
    let (archives, program, prepared) = folders(in: fetched.root)
    // The index is made afresh from the manifest each time: one an earlier stitch left holds the
    // same rows already.
    let indexURL = fetched.root.appendingPathComponent("index.sqlite")
    for suffix in [ "", "-wal", "-shm" ] {
      try? FileManager.default.removeItem(atPath: indexURL.path + suffix)
    }
    let index = try ArchiveIndex(url: indexURL)
    try index.importManifest(fetched.response.manifest)
    guard let summary = try index.recordings().first(where: { $0.id == recording.id }) else {
      throw DistributionError.nothingToStitch
    }
    // A take carries the encoding it was recorded with; one from before takes did is encoded with
    // the defaults, since this Mac has no TS Director settings of its own.
    let exporter = ExportService(
      index: index,
      archives: archives,
      programDirectory: program,
      fallbackEncoding: { AppConfig().takeEncoding }
    )
    let cameras: [(sourceID: SourceID, name: String)]
    let includeProgram: Bool
    switch fetched.track {
    case .primary:
      cameras = []
      includeProgram = true
    case .camera(let sourceID):
      let name = recording.cameras.first { $0.sourceID == sourceID }?.name ?? sourceID.rawValue
      cameras = [ (sourceID: sourceID, name: name) ]
      includeProgram = false
    }
    let urls = try await exporter.exportRecording(
      summary,
      cameras: cameras,
      includeProgram: includeProgram,
      programDirectory: program,
      preparedRoot: prepared,
      reprocess: true,
      window: window,
      progress: { item in progress(item.fraction) }
    )
    guard let url = urls.first else { throw DistributionError.nothingToStitch }
    return url
  }
}

/// Sums what several downloads have received, for one progress figure.
final class FetchTally: @unchecked Sendable {
  private let lock = NSLock()
  private var received: [String: Int64] = [:]
  private let total: Int64
  private let report: @Sendable (Int64, Int64) -> Void

  init(total: Int64, report: @escaping @Sendable (Int64, Int64) -> Void) {
    self.total = total
    self.report = report
  }

  func update(_ path: String, received bytes: Int64) {
    let sum = lock.withLock { () -> Int64 in
      received[path] = bytes
      return received.values.reduce(0, +)
    }
    report(sum, total)
  }
}
