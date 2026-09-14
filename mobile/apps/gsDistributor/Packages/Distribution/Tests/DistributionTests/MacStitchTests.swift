import AVFoundation
import DirectorClient
import DirectorCore
import DirectorExport
import DirectorLink
import Distribution
import DistributorWire
import Foundation
import PeerTubeKit
import Testing

/// A fake iPad with a real archive: it answers the manifest and file routes from an index and
/// files on disk, the way GS Director's backend does.
actor ArchiveBackend: DistributorBackend {
  let index: ArchiveIndex
  let exporter: ExportService
  let roots: FileRoots

  init(index: ArchiveIndex, exporter: ExportService, roots: FileRoots) {
    self.index = index
    self.exporter = exporter
    self.roots = roots
  }

  func identity() -> DirectorIdentity {
    DirectorIdentity(deviceName: "iPad", directorVersion: "test", directorID: UUID(), isRecording: false)
  }

  func recordings() throws -> [RecordingListing] { [] }
  func deleteRecordings(_ ids: [Int64]) -> [Int64] { [] }

  func manifest(recordingID: Int64, tracks: [Track]) throws -> ManifestResponse? {
    guard let recording = try index.recordings().first(where: { $0.id == recordingID }) else { return nil }
    let window = exporter.exportWindow(recording, sourceIDs: recording.sourceIDs)
    let cameras = tracks.compactMap { track -> SourceID? in
      if case .camera(let id) = track { return id }
      return nil
    }
    guard let manifest = try index.manifest(recordingID: recordingID, sourceIDs: cameras) else { return nil }
    let files = manifest.segments.map {
      RemoteFile(root: .archives, path: "\($0.sourceID.slug)/\($0.filename)", bytes: $0.byteCount)
    }
    return ManifestResponse(manifest: manifest, window: window, files: files)
  }

  func startJob(_ request: JobRequest, id: UUID, events: EventHub) throws {}
  func cancelJob(_ id: UUID) {}
}

@Suite("Stitching on the Mac", .serialized)
struct MacStitchTests {
  static func movie(at url: URL, frames: Int) async throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180
    ])
    writer.add(input)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    for index in 0..<frames {
      while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(2)) }
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(nil, 320, 180, kCVPixelFormatType_32BGRA, nil, &buffer)
      guard let buffer else { continue }
      adaptor.append(buffer, withPresentationTime: CMTime(seconds: Double(index) / 30, preferredTimescale: 600))
    }
    input.markAsFinished()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in writer.finishWriting { c.resume() } }
  }

  static func presentationTimes(of url: URL) async throws -> [Double] {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return [] }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    reader.startReading()
    var times: [Double] = []
    while let sample = output.copyNextSampleBuffer() {
      if CMSampleBufferGetNumSamples(sample) > 0 {
        times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
      }
    }
    return times
  }

  @Test("A camera stitched on the Mac over the protocol matches the iPad's own export")
  func matchesIPad() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("mac-stitch-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let archives = base.appendingPathComponent("iPad/Archives", isDirectory: true)
    let program = base.appendingPathComponent("iPad/Program", isDirectory: true)
    let prepared = base.appendingPathComponent("iPad/Prepared", isDirectory: true)
    for folder in [ archives, program, prepared, base.appendingPathComponent("Mac") ] {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    // An interrupted take: camera A three seconds at the start and three from 1 006 s; camera B
    // three seconds at the start. The shared window runs to 1 009 s.
    let index = try ArchiveIndex(url: base.appendingPathComponent("iPad/index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    let a = SourceID("cam-a")
    let b = SourceID("cam-b")
    for (source, sequence, start) in [ (a, 1, 1_000.0), (a, 2, 1_006.0), (b, 1, 1_000.0) ] {
      let filename = "rec-\(recordingID)/seg-\(sequence).mp4"
      let url = archives.appendingPathComponent(source.slug).appendingPathComponent(filename)
      try await Self.movie(at: url, frames: 90)
      let bytes = ((try FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
      try index.insertSegment(
        recordingID: recordingID, sourceID: source, sequence: sequence, filename: filename,
        isInitialization: false, startWall: WallClock(seconds: start), duration: 3,
        byteCount: bytes, firstFrameID: UInt64(sequence)
      )
    }
    let exporter = ExportService(index: index, archives: archives, programDirectory: program)
    let roots = FileRoots(archives: archives, program: program, prepared: prepared)
    let service = DistributorService(
      backend: ArchiveBackend(index: index, exporter: exporter, roots: roots),
      roots: roots,
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json")),
      peerTube: PeerTubeAccount(storage: MemoryAccountStorage())
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    defer { server.stop() }
    let connection = DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC")

    // What the iPad would make for camera B with the shared window.
    let summary = try #require(try index.recordings().first)
    let window = exporter.exportWindow(summary, sourceIDs: summary.sourceIDs)
    let onIPad = try await exporter.exportRecording(
      summary, cameras: [ (sourceID: b, name: "Away") ], includeProgram: false,
      programDirectory: program, preparedRoot: prepared, reprocess: true, window: window
    )

    // What the Mac makes for the same camera, over the protocol.
    let listing = RecordingListing(
      id: recordingID, startedAt: summary.startedAt, endedAt: nil, isLive: false, hasPrimary: false,
      cameras: [ CameraListing(sourceID: b, name: "Away", isNamed: true, bytes: 0) ], preparedTracks: []
    )
    let stitcher = MacStitcher(connection: connection, scratch: base.appendingPathComponent("Mac"))
    let onMac = try await stitcher.stitch(recording: listing, track: .camera(b), window: window) { _ in }

    let ipadURL = try #require(onIPad.first)
    #expect(onMac.lastPathComponent == ipadURL.lastPathComponent)
    let macTimes = try await Self.presentationTimes(of: onMac)
    let ipadTimes = try await Self.presentationTimes(of: ipadURL)
    #expect(!macTimes.isEmpty)
    #expect(macTimes == ipadTimes)
    let macLength = try await AVURLAsset(url: onMac).load(.duration).seconds
    #expect(abs(macLength - 9) < 0.35)
    #expect(abs(macLength - (try await AVURLAsset(url: ipadURL).load(.duration).seconds)) < 0.001)
  }
}
