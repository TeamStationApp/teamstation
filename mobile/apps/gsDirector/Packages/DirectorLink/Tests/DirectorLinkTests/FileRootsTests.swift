import DirectorLink
import DistributorWire
import Foundation
import Testing

@Suite("File roots")
struct FileRootsTests {
  @Test("Only files inside the named root are reachable")
  func confinement() throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("file-roots-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let take = base.appendingPathComponent("Archives/cam_a/rec-1", isDirectory: true)
    try FileManager.default.createDirectory(at: take, withIntermediateDirectories: true)
    try Data("segment".utf8).write(to: take.appendingPathComponent("seg-1.mp4"))
    let secret = base.appendingPathComponent("secret.txt")
    try Data("secret".utf8).write(to: secret)
    try FileManager.default.createSymbolicLink(
      at: base.appendingPathComponent("Archives/cam_a/escape"),
      withDestinationURL: secret
    )

    let roots = FileRoots(
      archives: base.appendingPathComponent("Archives", isDirectory: true),
      program: base.appendingPathComponent("Program", isDirectory: true),
      prepared: base.appendingPathComponent("Prepared", isDirectory: true)
    )

    let url = try #require(roots.url(root: .archives, relativePath: "cam_a/rec-1/seg-1.mp4"))
    #expect(try Data(contentsOf: url) == Data("segment".utf8))
    #expect(roots.relativePath(of: url, in: .archives) == "cam_a/rec-1/seg-1.mp4")

    #expect(roots.url(root: .archives, relativePath: "cam_a/rec-1/../../../secret.txt") == nil)
    #expect(roots.url(root: .archives, relativePath: "/etc/hosts") == nil)
    #expect(roots.url(root: .archives, relativePath: "cam_a/escape") == nil)
    #expect(roots.url(root: .archives, relativePath: "cam_a/rec-1") == nil)
    #expect(roots.url(root: .archives, relativePath: "cam_a/rec-1/missing.mp4") == nil)
    #expect(roots.url(root: .archives, relativePath: "") == nil)
    #expect(roots.url(root: .program, relativePath: "cam_a/rec-1/seg-1.mp4") == nil)
  }
}

@Suite("Distributor settings store")
struct DistributorSettingsStoreTests {
  @Test("Saved settings load back; a missing or broken file loads the defaults")
  func saveAndLoad() throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("settings-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let url = base.appendingPathComponent("Distributor/settings.json")
    let store = DistributorSettingsStore(url: url)
    #expect(store.load() == DistributorSettings())

    let settings = DistributorSettings(destinations: [ "MAC-A": "/Users/a/Movies" ], createCombined: true)
    try store.save(settings)
    #expect(store.load() == settings)

    try Data("not json".utf8).write(to: url)
    #expect(store.load() == DistributorSettings())
  }

  @Test("A Mac may change only its own download folder")
  func mergeKeepsOtherMacs() {
    let stored = DistributorSettings(destinations: [ "MAC-A": "/a", "MAC-B": "/b" ])
    let incoming = DistributorSettings(
      destinations: [ "MAC-A": "/a2", "MAC-B": "/somewhere-else" ],
      createCombined: true
    )

    let merged = DistributorSettingsStore.merge(incoming, into: stored, mac: "MAC-A")
    #expect(merged.destinations == [ "MAC-A": "/a2", "MAC-B": "/b" ])
    #expect(merged.createCombined)

    let anonymous = DistributorSettingsStore.merge(incoming, into: stored, mac: nil)
    #expect(anonymous.destinations == stored.destinations)
  }
}
