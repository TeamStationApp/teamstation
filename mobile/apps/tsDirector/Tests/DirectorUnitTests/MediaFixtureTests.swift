import Foundation
import Testing

/// I3: the golden vectors the Kotlin port asserts. Writing them is the test: every listed fixture
/// is produced, a second writing is byte-identical to the first, and what is on disk is what the
/// code produces now.
@Suite("Media fixtures", .serialized)
struct MediaFixtureTests {
  static let expected = [
    "programme-export-placement.json",
    "programme-grid-placement.json",
    "programme-hold-fill.json",
    "programme-resumed-part.json",
    "programme-sound-origin.json",
    "reconnect-backoff.json",
    "rtmp-aac-raw-tag.bin",
    "rtmp-aac-sequence-header-tag.bin",
    "rtmp-audio-extended-timestamp.bin",
    "rtmp-connect-h264.bin",
    "rtmp-connect-hevc.bin",
    "rtmp-handshake-c0c1-head.bin",
    "rtmp-handshake-c2.bin",
    "rtmp-hevc-delta-tag.bin",
    "rtmp-hevc-keyframe-tag.bin",
    "rtmp-hevc-sequence-start-tag.bin",
    "rtmp-onmetadata-hevc.bin",
    "rtmp-publish.bin",
    "rtmp-send-budget.json",
    "rtmp-video-chunked-128.bin",
    "rtmp-wire.json",
    "stream-audio-stamps.json",
    "stream-encode-clock.json",
    "stream-stall-policy.json",
    "stream-stall-redial.json"
  ]

  @Test("Every fixture is written, and writing again changes no byte")
  func writesEveryFixtureDeterministically() throws {
    let first = try MediaFixtureWriter.write()
    #expect(first.map(\.name) == Self.expected)
    #expect(first.allSatisfy { !$0.data.isEmpty })
    let again = MediaFixtureWriter.files()
    #expect(again == first)
    for file in first {
      let onDisk = try Data(contentsOf: MediaFixtureWriter.directory.appendingPathComponent(file.name))
      #expect(onDisk == file.data, "\(file.name) on disk differs from what was written")
    }
  }

  @Test("Into a scratch directory, twice, the bytes are the same")
  func scratchWritesMatch() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("media-fixtures-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let first = try MediaFixtureWriter.write(to: root)
    let second = try MediaFixtureWriter.write(to: root)
    #expect(first == second)
    let names = try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
    #expect(names == Self.expected)
  }
}
