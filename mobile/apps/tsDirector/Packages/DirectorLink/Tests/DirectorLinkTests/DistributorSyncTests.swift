import DirectorLink
import DistributorWire
import Foundation
import Testing

@Suite("Settings shared with the Mac")
struct DistributorSyncTests {
  struct Rig {
    var base: URL
    var service: DistributorService
    var settings: DistributorSettingsStore

    func send(_ method: String, _ path: String, _ body: some Encodable, mac: String? = nil) async throws -> (status: Int, data: Data) {
      var headers: [String: String] = [:]
      if let mac { headers["x-distributor-mac"] = mac }
      let response = await service.handle(HTTPRequest(
        method: method,
        path: path,
        headers: headers,
        body: try JSONEncoder().encode(body)
      ))
      guard case let .data(status, _, data) = response else { throw CancellationError() }
      return (status, data)
    }

    func get(_ path: String) async throws -> (status: Int, data: Data) {
      guard case let .data(status, _, data) = await service.handle(HTTPRequest(method: "GET", path: path)) else {
        throw CancellationError()
      }
      return (status, data)
    }
  }

  static func rig() -> Rig {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("sync-\(UUID().uuidString)", isDirectory: true)
    let settings = DistributorSettingsStore(url: base.appendingPathComponent("settings.json"))
    let service = DistributorService(
      backend: FakeBackend(),
      roots: FileRoots(archives: base, program: base, prepared: base),
      settings: settings
    )
    return Rig(base: base, service: service, settings: settings)
  }

  static func at(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_800_000_000 + seconds) }

  @Test("A Mac's save keeps the iPad's newer groups, takes its own newer ones, and only its own folder")
  func stampedSave() async throws {
    let rig = Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.base) }
    var stored = DistributorSettings(destinations: [ "MAC-B": "/B" ], createCombined: true)
    stored.stamps[SettingsGroup.createCombined.key] = SettingsStamp(modifiedAt: Self.at(50), by: SettingsStamp.iPad)
    try rig.settings.save(stored)

    var incoming = DistributorSettings(destinations: [ "MAC-A": "/A", "MAC-B": "/Hijacked" ], createCombined: false)
    incoming.upload.choice.combined = true
    incoming.stamps[SettingsGroup.createCombined.key] = SettingsStamp(modifiedAt: Self.at(10), by: "MAC-A")
    incoming.stamps[SettingsGroup.upload.key] = SettingsStamp(modifiedAt: Self.at(60), by: "MAC-A")
    incoming.stamps[SettingsGroup.destination(mac: "MAC-A").key] = SettingsStamp(modifiedAt: Self.at(60), by: "MAC-A")
    incoming.stamps[SettingsGroup.destination(mac: "MAC-B").key] = SettingsStamp(modifiedAt: Self.at(99), by: "MAC-A")

    let answer = try await rig.send("PUT", "/v1/settings", incoming, mac: "MAC-A")
    #expect(answer.status == 200)
    let saved = rig.settings.load()
    #expect(saved.createCombined)
    #expect(saved.upload.choice.combined)
    #expect(saved.destinations == [ "MAC-A": "/A", "MAC-B": "/B" ])
    #expect(saved.stamp(.destination(mac: "MAC-B")) == nil)
    #expect(try JSONDecoder().decode(DistributorSettings.self, from: answer.data) == saved)
  }

  @Test("A Mac from before stamps still has everything it sends taken")
  func unstampedSave() async throws {
    let rig = Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.base) }
    var stored = DistributorSettings(createCombined: true)
    stored.stamps[SettingsGroup.createCombined.key] = SettingsStamp(modifiedAt: Self.at(50), by: SettingsStamp.iPad)
    try rig.settings.save(stored)
    _ = try await rig.send("PUT", "/v1/settings", DistributorSettings(createCombined: false), mac: "MAC-A")
    #expect(!rig.settings.load().createCombined)
  }

  @Test("Settings go back and forth with the Mac, and no login is served")
  func settingsWithoutLogins() async throws {
    let rig = Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.base) }
    // What the iPad kept before: a group this build no longer has, and its stamp.
    try FileManager.default.createDirectory(at: rig.base, withIntermediateDirectories: true)
    let kept = #"""
      {"version":2,"createCombined":true,"retiredGroup":{"teams":[]},
       "stamps":{"retiredGroup":{"modifiedAt":800000000,"by":"MAC-A"},"createCombined":{"modifiedAt":800000000,"by":"ipad"}}}
      """#
    try Data(kept.utf8).write(to: rig.base.appendingPathComponent("settings.json"))
    let loaded = rig.settings.load()
    #expect(loaded.createCombined)
    #expect(Set(loaded.stamps.keys) == [ "createCombined" ])

    var incoming = loaded
    incoming.destinations["MAC-A"] = "/A"
    incoming = incoming.stampingChanges(from: loaded, by: "MAC-A", at: Self.at(70))
    let answer = try await rig.send("PUT", "/v1/settings", incoming, mac: "MAC-A")
    #expect(answer.status == 200)
    let fetched = try await rig.get("/v1/settings")
    #expect(fetched.status == 200)
    let settings = try JSONDecoder().decode(DistributorSettings.self, from: fetched.data)
    #expect(settings.destinations == [ "MAC-A": "/A" ])
    #expect(settings.createCombined)
    let written = try #require(try JSONSerialization.jsonObject(with: fetched.data) as? [String: Any])
    #expect(Set(written.keys) == [ "version", "destinations", "createCombined", "combinedLayout", "upload", "stamps" ])

    for (method, path) in [ ("GET", "/v1/logins"), ("PUT", "/v1/logins/any"), ("DELETE", "/v1/logins/any"), ("GET", "/v1/logins/any/secret") ] {
      #expect(try await rig.send(method, path, "").status == 404, "\(method) \(path)")
    }
  }
}
