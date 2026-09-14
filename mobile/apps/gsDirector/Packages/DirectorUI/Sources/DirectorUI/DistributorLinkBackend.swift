import AVFoundation
import DirectorCore
import DirectorDVR
import DirectorExport
import DirectorLink
import DistributorWire
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// GS Director's answers to GS Distributor, read from the running app.
///
/// The app's own state is read on the main actor; everything that touches the index or the disk
/// runs off it. Stitching goes through the same `ExportService` the Recordings screen uses, so a
/// file stitched here for the Mac is the file the iPad would have shared.
final class DistributorLinkBackend: DistributorBackend, @unchecked Sendable {
  /// Read only on the main actor.
  private weak var environment: AppEnvironment?
  private let index: ArchiveIndex
  private let exporter: ExportService
  private let roots: FileRoots
  private let jobs = JobRegistry()

  @MainActor
  init(environment: AppEnvironment, index: ArchiveIndex, exporter: ExportService, roots: FileRoots) {
    self.environment = environment
    self.index = index
    self.exporter = exporter
    self.roots = roots
  }

  func identity() async -> DirectorIdentity {
    await MainActor.run {
      DirectorIdentity(
        // iPadOS reports the model here, not the owner's name for the iPad; GS Distributor asks
        // lockdownd for that over the cable.
        deviceName: UIDevice.current.name,
        directorVersion: Self.version,
        directorID: Self.installID,
        isRecording: environment?.isRecording ?? false
      )
    }
  }

  func recordings() async throws -> [RecordingListing] {
    let recordings = try index.recordings()
    let sourceIDs = Set(recordings.flatMap(\.sourceIDs))
    let (liveNames, liveID) = await MainActor.run { () -> ([SourceID: String], Int64?) in
      guard let environment else { return ([:], nil) }
      var names: [SourceID: String] = [:]
      for sourceID in sourceIDs {
        names[sourceID] = environment.recordingCameraName(for: sourceID)
      }
      return (names, environment.activeRecordingID)
    }
    let bytes = try index.bytesBySource()

    return recordings.map { recording in
      let recorded = (try? index.recordedCameraNames(recordingID: recording.id)) ?? [:]
      let cameras = recording.sourceIDs.map { sourceID in
        let name = recorded[sourceID] ?? liveNames[sourceID] ?? sourceID.rawValue
        return CameraListing(
          sourceID: sourceID,
          name: name,
          isNamed: name != sourceID.rawValue,
          bytes: bytes[recording.id]?[sourceID] ?? 0
        )
      }
      return RecordingListing(
        id: recording.id,
        startedAt: recording.startedAt,
        endedAt: recording.endedAt,
        isLive: recording.id == liveID,
        hasPrimary: recording.programFilename != nil,
        cameras: cameras,
        preparedTracks: preparedTracks(of: recording, cameras: cameras)
      )
    }
  }

  func deleteRecordings(_ ids: [Int64]) async throws -> [Int64] {
    await MainActor.run {
      guard let environment else { return ids }
      let live = environment.activeRecordingID
      // Skips the live take itself; it is reported back as refused.
      environment.deleteRecordings(ids: ids)
      return ids.filter { $0 == live }
    }
  }

  func manifest(recordingID: Int64, tracks: [Track]) async throws -> ManifestResponse? {
    guard let recording = try index.recordings().first(where: { $0.id == recordingID }) else { return nil }
    // Over every camera the take has, not only those asked for, so the files stitched here and on
    // the Mac all come out the same length.
    let window = exporter.exportWindow(recording, sourceIDs: recording.sourceIDs)
    let cameraIDs = tracks.compactMap { track -> SourceID? in
      if case .camera(let sourceID) = track { return sourceID }
      return nil
    }
    guard let manifest = try index.manifest(recordingID: recordingID, sourceIDs: cameraIDs) else { return nil }

    var files = manifest.segments.map {
      RemoteFile(root: .archives, path: "\($0.sourceID.slug)/\($0.filename)", bytes: $0.byteCount)
    }
    if tracks.contains(.primary), let program = recording.programFilename {
      for url in RecordingExport.programSourceFiles(named: program, in: roots.program) {
        files.append(RemoteFile(root: .program, path: url.lastPathComponent, bytes: Self.size(of: url)))
      }
    }
    return ManifestResponse(manifest: manifest, window: window, files: files)
  }

  func startJob(_ request: JobRequest, id: UUID, events: EventHub) async throws {
    guard let recording = try index.recordings().first(where: { $0.id == request.recordingID }) else {
      throw DistributorRefusal.notFound
    }
    let cameras: [(sourceID: SourceID, name: String)]
    let includeProgram: Bool
    let isRecording: Bool
    switch request.track {
    case .primary:
      cameras = []
      includeProgram = true
      isRecording = await MainActor.run { environment?.isRecording ?? true }
    case .camera(let sourceID):
      let (name, recording) = await MainActor.run {
        (environment?.recordingCameraName(for: sourceID, in: request.recordingID) ?? sourceID.rawValue,
         environment?.isRecording ?? true)
      }
      cameras = [ (sourceID: sourceID, name: name) ]
      includeProgram = false
      isRecording = recording
    }
    if isRecording { throw DistributorRefusal.recording }

    let exporter = self.exporter
    let roots = self.roots
    let jobs = self.jobs
    let task = Task.detached(priority: .utility) {
      defer { jobs.remove(id) }
      do {
        let urls = try await exporter.exportRecording(
          recording,
          cameras: cameras,
          includeProgram: includeProgram,
          preparedRoot: roots.prepared,
          reprocess: request.reprocess,
          window: request.window,
          progress: { item in events.publish(.jobProgress(jobID: id, fraction: item.fraction)) }
        )
        guard !Task.isCancelled else { return }
        guard let url = urls.first, let path = roots.relativePath(of: url, in: .prepared) else {
          events.publish(.jobFailed(jobID: id, reason: "nothing to stitch for that track"))
          return
        }
        events.publish(.jobFinished(
          jobID: id,
          file: RemoteFile(root: .prepared, path: path, bytes: Self.size(of: url))
        ))
      } catch {
        events.publish(.jobFailed(jobID: id, reason: "\(error)"))
      }
    }
    jobs.insert(id, task)
  }

  /// The remux itself runs to the end; a cancelled job just reports nothing when it does.
  func cancelJob(_ id: UUID) async {
    jobs.cancel(id)
  }

  /// The scrub proxy's still nearest that moment when there is one within two seconds -- it is
  /// already a small JPEG -- and otherwise a frame decoded from the segment that covers it.
  func still(recordingID: Int64, sourceID: SourceID, at seconds: Double) async throws -> Data? {
    guard let recording = try index.recordings().first(where: { $0.id == recordingID }) else { return nil }
    let wall = recording.startedAt + seconds
    if let record = try index.proxyStill(for: sourceID, nearest: wall),
       abs(record.wall - wall) <= 2,
       let data = ProxyReader(index: index).data(for: record) {
      return data
    }
    guard let segment = try index.segments(for: sourceID, from: wall, to: wall + 0.001)
      .first(where: { !$0.isInitialization })
    else { return nil }
    let url = roots.archives
      .appendingPathComponent(sourceID.slug, isDirectory: true)
      .appendingPathComponent(segment.filename)
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.maximumSize = CGSize(width: 640, height: 360)
    generator.appliesPreferredTrackTransform = true
    let offset = max(0, wall - segment.startWall)
    guard let image = try? await generator.image(at: CMTime(seconds: offset, preferredTimescale: 600)).image else {
      return nil
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
      return nil
    }
    CGImageDestinationAddImage(destination, image, [ kCGImageDestinationLossyCompressionQuality: 0.8 ] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }

  // MARK: - Helpers

  private func preparedTracks(of recording: RecordingSummary, cameras: [CameraListing]) -> [Track] {
    let directory = RecordingExport.preparedDirectory(recordingID: recording.id, in: roots.prepared)
    var tracks: [Track] = []
    if recording.programFilename != nil,
       Self.size(of: directory.appendingPathComponent(
         RecordingExport.programFilename(startedAt: recording.startedAt)
       )) > 0 {
      tracks.append(.primary)
    }
    for camera in cameras {
      let url = directory.appendingPathComponent(
        RecordingExport.cameraFilename(startedAt: recording.startedAt, cameraName: camera.name)
      )
      if Self.size(of: url) > 0 { tracks.append(.camera(camera.sourceID)) }
    }
    return tracks
  }

  static func size(of url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
  }

  static var version: String {
    let info = Bundle.main.infoDictionary
    let short = info?["CFBundleShortVersionString"] as? String ?? "?"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    return "\(short) (\(build))"
  }

  /// Stable for this install of GS Director, so the Mac can tell two iPads apart.
  static var installID: UUID {
    let key = "co.gamestation.director.installID"
    if let raw = UserDefaults.standard.string(forKey: key), let id = UUID(uuidString: raw) { return id }
    let id = UUID()
    UserDefaults.standard.set(id.uuidString, forKey: key)
    return id
  }
}

/// Stitching jobs in flight, by id.
private final class JobRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var tasks: [UUID: Task<Void, Never>] = [:]

  func insert(_ id: UUID, _ task: Task<Void, Never>) {
    lock.withLock { tasks[id] = task }
  }

  func remove(_ id: UUID) {
    _ = lock.withLock { tasks.removeValue(forKey: id) }
  }

  func cancel(_ id: UUID) {
    lock.withLock { tasks[id] }?.cancel()
  }
}
