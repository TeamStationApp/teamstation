import DirectorLink
import DistributorWire
import Foundation
import PeerTubeKit
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
      settings: settings,
      peerTube: PeerTubeAccount(storage: MemoryAccountStorage())
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
    incoming.stamps[SettingsGroup.createCombined.key] = SettingsStamp(modifiedAt: Self.at(10), by: "MAC-A")
    incoming.stamps[SettingsGroup.destination(mac: "MAC-A").key] = SettingsStamp(modifiedAt: Self.at(60), by: "MAC-A")
    incoming.stamps[SettingsGroup.destination(mac: "MAC-B").key] = SettingsStamp(modifiedAt: Self.at(99), by: "MAC-A")

    let answer = try await rig.send("PUT", "/v1/settings", incoming, mac: "MAC-A")
    #expect(answer.status == 200)
    let saved = rig.settings.load()
    #expect(saved.createCombined)
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
}
