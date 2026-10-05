import AVFoundation
import DirectorClient
import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Testing

@Suite("A take's segments kept on this Mac", .serialized)
struct KeptSegmentsTests {
  static func base(_ name: String) -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
  }

  static func length(of url: URL) async throws -> Double {
    try await AVURLAsset(url: url).load(.duration).seconds
  }

  @Test("Segments stay after stitching, and a reprocess stitches from them with no iPad")
  @MainActor
  func restitchWithoutTheIPad() async throws {
    let base = Self.base("kept")
    defer { try? FileManager.default.removeItem(at: base) }
    let iPad = try await FakeIPad.start(in: base, takesAt: [ 1_000 ])
    defer { iPad.server.stop() }
    let recording = try #require(iPad.recordings.first)
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    let (home, away) = (Track.camera(FakeIPad.home), Track.camera(FakeIPad.away))

    let first = DistributionRun(
      recording: recording, tracks: [ home, away ], connection: iPad.connection, jobs: JobWatcher(), destination: destination
    )
    await first.run()
    guard case .done(let homeFile) = first.states[home], case .done(let awayFile) = first.states[away] else {
      Issue.record("the first export did not finish: \(first.states)")
      return
    }
    let homeLength = try await Self.length(of: homeFile)
    let awayLength = try await Self.length(of: awayFile)

    // Kept beside the files, each camera's laid out as the iPad lays its own out.
    let take = KeptSegments.folder(for: recording, in: destination)
    #expect(take.deletingLastPathComponent().lastPathComponent == KeptSegments.folderName)
    #expect(take.deletingLastPathComponent().deletingLastPathComponent() == first.folder)
    #expect(KeptSegments.tracks(of: recording, in: destination) == [ home, away ])
    let camera = take.appendingPathComponent("camera-\(FakeIPad.home.slug)")
    for name in [ "manifest.json", "index.sqlite", "Archives" ] {
      #expect(FileManager.default.fileExists(atPath: camera.appendingPathComponent(name).path), "\(name) missing")
    }
    let inventory = ExportInventory(recording: recording, destination: destination)
    #expect(inventory.segmentsOnMac == [ home, away ])
    #expect(!inventory.needsIPad([ home, away ], reprocess: true))

    // The iPad is gone (it went with the export lock), and one file is too.
    #expect(await iPad.backend.handedBack)
    try FileManager.default.removeItem(at: homeFile)
    #expect(!ExportInventory(recording: recording, destination: destination).needsIPad([ home, away ]))
    let again = DistributionRun(
      recording: recording, tracks: [ home, away ], connection: nil, jobs: JobWatcher(), destination: destination,
      reprocess: true
    )
    let batch = DistributionBatch(runs: [ again ], connection: nil)
    await batch.run()

    #expect(batch.isFinished && !batch.wasCancelled)
    #expect(again.states[home] == .done(homeFile))
    #expect(again.states[away] == .done(awayFile))
    #expect(abs(try await Self.length(of: homeFile) - homeLength) < 0.001)
    #expect(abs(try await Self.length(of: awayFile) - awayLength) < 0.001)
    // Nothing more was asked of the iPad, and the segments are still there for next time.
    #expect(await iPad.backend.locksGranted == 1)
    #expect(KeptSegments.tracks(of: recording, in: destination) == [ home, away ])
  }

  @Test("Removing a take's segments is refused while a run is exporting it, and gives the room back")
  @MainActor
  func removal() async throws {
    let base = Self.base("kept-remove")
    defer { try? FileManager.default.removeItem(at: base) }
    let iPad = try await FakeIPad.start(in: base, takesAt: [ 1_000, 2_000 ])
    defer { iPad.server.stop() }
    let (recording, other) = (iPad.recordings[0], iPad.recordings[1])
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    let run = DistributionRun(
      recording: recording, tracks: [ .camera(FakeIPad.home) ], connection: iPad.connection, jobs: JobWatcher(),
      destination: destination
    )
    await run.run()
    #expect(KeptSegments.tracks(of: recording, in: destination) == [ .camera(FakeIPad.home) ])

    // A run of this take, not yet finished, uses them; one of another take does not.
    let busy = DistributionBatch(
      runs: [ DistributionRun(recording: recording, tracks: [], connection: nil, jobs: JobWatcher(), destination: destination) ],
      connection: nil
    )
    let elsewhere = DistributionBatch(
      runs: [ DistributionRun(recording: other, tracks: [], connection: nil, jobs: JobWatcher(), destination: destination) ],
      connection: nil
    )
    #expect(try KeptSegments.remove(recording, in: destination, unlessUsedBy: busy) == .inUse)
    #expect(KeptSegments.tracks(of: recording, in: destination) == [ .camera(FakeIPad.home) ])

    let take = KeptSegments.folder(for: recording, in: destination)
    let removal = try KeptSegments.remove(recording, in: destination, unlessUsedBy: elsewhere)
    guard case .removed(let bytes) = removal else {
      Issue.record("not removed: \(removal)")
      return
    }
    #expect(bytes > 0)
    #expect(!FileManager.default.fileExists(atPath: take.path))
    // The last take's going takes the hidden folder with it; the saved file stays.
    #expect(!FileManager.default.fileExists(atPath: take.deletingLastPathComponent().path))
    guard case .done(let saved) = run.states[.camera(FakeIPad.home)] else {
      Issue.record("not saved")
      return
    }
    #expect(DistributionRunTestSupport.size(of: saved) > 0)
    #expect(KeptSegments.tracks(of: recording, in: destination).isEmpty)
    #expect(try KeptSegments.remove(recording, in: destination, unlessUsedBy: nil) == KeptSegments.Removal.none)
  }

  @Test("Cancelling keeps the segments already off the iPad; a fetch cut short leaves nothing")
  @MainActor
  func cancelKeepsWholeFetches() async throws {
    let base = Self.base("kept-cancel")
    defer { try? FileManager.default.removeItem(at: base) }
    let iPad = try await FakeIPad.start(in: base, takesAt: [ 1_000 ])
    defer { iPad.server.stop() }
    let recording = try #require(iPad.recordings.first)
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    // What an earlier fetch that never finished left: a camera folder with no manifest.
    let take = KeptSegments.folder(for: recording, in: destination)
    let cutShort = take.appendingPathComponent("camera-gone", isDirectory: true)
    try FileManager.default.createDirectory(at: cutShort, withIntermediateDirectories: true)

    let run = DistributionRun(
      recording: recording, tracks: [ .camera(FakeIPad.home), .camera(FakeIPad.away) ], connection: iPad.connection,
      jobs: JobWatcher(), destination: destination
    )
    let exporting = Task { await run.run() }
    while !run.tracks.contains(where: { run.states[$0] == .fetched }), !run.isFinished {
      try await Task.sleep(for: .milliseconds(1))
    }
    run.cancel()
    await exporting.value

    #expect(run.wasCancelled)
    let kept = KeptSegments.tracks(of: recording, in: destination)
    #expect(!kept.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: cutShort.path))
    // Every folder left is a whole fetch.
    let left = try FileManager.default.contentsOfDirectory(atPath: take.path)
    #expect(left.count == kept.count)
    for name in left {
      #expect(FileManager.default.fileExists(atPath: take.appendingPathComponent(name).appendingPathComponent("manifest.json").path))
    }
  }
}
