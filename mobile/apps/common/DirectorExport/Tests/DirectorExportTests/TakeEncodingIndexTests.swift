import Foundation
import DirectorCore
import DirectorExport
import Testing

@Suite("Take encoding in the index")
struct TakeEncodingIndexTests {
  private let encoding = TakeEncoding(
    rawCamera: EncodeSettings(codec: .hevc, resolution: .hd1080, frameRate: 60, bitrate: 6_000_000, keyframeSeconds: 2),
    programme: EncodeSettings(codec: .h264, resolution: .hd720, frameRate: 30, bitrate: 4_000_000, keyframeSeconds: 2)
  )

  private func scratch() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("take-encoding-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  @Test("A take keeps the encoding it started with")
  func keepsEncoding() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.saveEncoding(encoding, for: id)
    #expect(try index.encoding(for: id) == encoding)
    #expect(try index.recordings().first?.encoding == encoding)
  }

  @Test("A take recorded before encodings were kept has none")
  func olderTakeHasNone() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))
    #expect(try index.encoding(for: id) == nil)
    #expect(try index.recordings().first?.encoding == nil)
  }

  @Test("The encoding travels to the Mac in the manifest")
  func travelsInManifest() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.saveEncoding(encoding, for: id)
    let manifest = try #require(try index.manifest(recordingID: id, sourceIDs: []))
    #expect(manifest.encoding == encoding)

    let json = try JSONEncoder().encode(manifest)
    let mac = try ArchiveIndex(url: root.appendingPathComponent("mac.sqlite"))
    try mac.importManifest(try JSONDecoder().decode(RecordingManifest.self, from: json))
    #expect(try mac.recordings().first?.encoding == encoding)
  }

  @Test("A manifest from an iPad that sends no encoding still loads")
  func olderManifestLoads() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.saveEncoding(encoding, for: id)
    let manifest = try #require(try index.manifest(recordingID: id, sourceIDs: []))
    var object = try #require(
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(manifest)) as? [String: Any]
    )
    object.removeValue(forKey: "encoding")
    let older = try JSONDecoder().decode(
      RecordingManifest.self,
      from: JSONSerialization.data(withJSONObject: object)
    )
    #expect(older.encoding == nil)
    #expect(older.recordingID == id)
  }
}
