import DirectorClient
import DirectorCore
import DirectorExport
import DistributorWire
import Foundation

/// Stitches one track on this Mac with GS Director's own `ExportService`.
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

  public enum Stage: Sendable, Equatable {
    case fetching(received: Int64, total: Int64)
    case stitching(Double)
  }

  /// Returns the stitched file, still inside `scratch`.
  public func stitch(
    recording: RecordingListing,
    track: Track,
    window: ExportWindow,
    progress: @escaping @Sendable (Stage) -> Void
  ) async throws -> URL {
    let response = try await connection.manifest(recordingID: recording.id, tracks: [ track ])
    let root = scratch.appendingPathComponent("stitch-\(UUID().uuidString)", isDirectory: true)
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

    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    try index.importManifest(response.manifest)
    guard let summary = try index.recordings().first(where: { $0.id == recording.id }) else {
      throw DistributionError.nothingToStitch
    }
    let exporter = ExportService(index: index, archives: archives, programDirectory: program)
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

/// Stitches one track on the iPad and says where the result is.
public struct IPadStitcher: Sendable {
  public let connection: DirectorConnection
  public let jobs: JobWatcher

  public init(connection: DirectorConnection, jobs: JobWatcher) {
    self.connection = connection
    self.jobs = jobs
  }

  public func stitch(
    recording: RecordingListing,
    track: Track,
    window: ExportWindow,
    reprocess: Bool,
    progress: @escaping @Sendable (Double) -> Void
  ) async throws -> RemoteFile {
    try Task.checkCancellation()
    let id = try await connection.startJob(
      JobRequest(recordingID: recording.id, track: track, window: window, reprocess: reprocess)
    )
    let connection = self.connection
    let jobs = self.jobs
    // Cancelling stops the wait here and tells the iPad, which then reports nothing for the job.
    return try await withTaskCancellationHandler {
      try await jobs.wait(for: id, progress: progress)
    } onCancel: {
      Task {
        await jobs.cancel(id)
        try? await connection.cancelJob(id)
      }
    }
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
