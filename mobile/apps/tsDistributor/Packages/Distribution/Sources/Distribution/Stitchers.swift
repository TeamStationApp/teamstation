import DirectorClient
import DirectorCore
import DirectorExport
import DistributorWire
import Foundation

/// Stitches one track on this Mac with TS Director's own `ExportService`.
///
/// It fetches the index rows and the files the track reads into a scratch folder laid out as the
/// iPad lays them out, loads the rows into a scratch index, and exports with the window the whole
/// export shares, so the file is the one the iPad would have made.
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

  /// Returns the stitched file, still inside `scratch`.
  ///
  /// Cancelling the task stops the downloads and the stitch where they are, and the work folder goes
  /// with them: nothing of a cancelled or failed stitch is left in `scratch`.
  public func stitch(
    recording: RecordingListing,
    track: Track,
    window: ExportWindow,
    progress: @escaping @Sendable (Stage) -> Void
  ) async throws -> URL {
    let response = try await connection.manifest(recordingID: recording.id, tracks: [ track ])
    let root = scratch.appendingPathComponent("stitch-\(UUID().uuidString)", isDirectory: true)
    do {
      return try await stitch(
        recording: recording,
        track: track,
        window: window,
        response: response,
        in: root,
        progress: progress
      )
    } catch {
      try? FileManager.default.removeItem(at: root)
      throw error
    }
  }

  private func stitch(
    recording: RecordingListing,
    track: Track,
    window: ExportWindow,
    response: ManifestResponse,
    in root: URL,
    progress: @escaping @Sendable (Stage) -> Void
  ) async throws -> URL {
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    let prepared = root.appendingPathComponent("Prepared", isDirectory: true)
    for folder in [ archives, program, prepared ] {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    let files = response.files
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

    try Task.checkCancellation()

    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    try index.importManifest(response.manifest)
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
    switch track {
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
      progress: { item in progress(.stitching(item.fraction)) }
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
  private let report: @Sendable (MacStitcher.Stage) -> Void

  init(total: Int64, report: @escaping @Sendable (MacStitcher.Stage) -> Void) {
    self.total = total
    self.report = report
  }

  func update(_ path: String, received bytes: Int64) {
    let sum = lock.withLock { () -> Int64 in
      received[path] = bytes
      return received.values.reduce(0, +)
    }
    report(.fetching(received: sum, total: total))
  }
}
