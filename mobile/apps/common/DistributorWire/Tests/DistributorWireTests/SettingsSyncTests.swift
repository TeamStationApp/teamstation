import DistributorWire
import Foundation
import Testing

@Suite("Settings sync")
struct SettingsSyncTests {
  static let mac = "MAC-1"
  static let otherMac = "MAC-2"
  static func at(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_800_000_000 + seconds) }

  @Test("Only the groups that changed are stamped, with the device and the time")
  func stampsChanges() {
    let old = DistributorSettings(createCombined: false)
    var edited = old
    edited.createCombined = true
    edited.destinations[Self.mac] = "/Movies/TeamStation"
    let stamped = edited.stampingChanges(from: old, by: Self.mac, at: Self.at(10))
    #expect(stamped.stamp(.createCombined) == SettingsStamp(modifiedAt: Self.at(10), by: Self.mac))
    #expect(stamped.stamp(.destination(mac: Self.mac))?.by == Self.mac)
    #expect(stamped.stamp(.upload) == nil)
    #expect(stamped.stamps.count == 2)
  }

  @Test("Each group comes from whichever device changed it last, in both directions")
  func newestWinsPerGroup() {
    var ipad = DistributorSettings()
    ipad.createCombined = true
    ipad.stamps[SettingsGroup.createCombined.key] = SettingsStamp(modifiedAt: Self.at(20), by: SettingsStamp.iPad)
    ipad.upload.choice.combined = true
    ipad.stamps[SettingsGroup.upload.key] = SettingsStamp(modifiedAt: Self.at(5), by: SettingsStamp.iPad)

    var mac = DistributorSettings()
    mac.createCombined = false
    mac.stamps[SettingsGroup.createCombined.key] = SettingsStamp(modifiedAt: Self.at(10), by: Self.mac)
    mac.upload.choice.combined = false
    mac.stamps[SettingsGroup.upload.key] = SettingsStamp(modifiedAt: Self.at(30), by: Self.mac)

    let merged = mac.reconciled(with: ipad)
    #expect(merged.createCombined)
    #expect(merged.upload.choice.combined == false)
    #expect(merged.stamp(.createCombined)?.by == SettingsStamp.iPad)
    #expect(merged.stamp(.upload)?.by == Self.mac)
    // The same answer whichever side brings them together.
    #expect(ipad.reconciled(with: mac) == merged)
  }

  @Test("A first Mac copy with nothing stamped takes everything the iPad has")
  func freshMacAdoptsIPad() throws {
    let old = #"{"version":1,"createCombined":true,"destinations":{"MAC-1":"/Movies/TS"},"peerTube":{"enabled":true,"host":"videos.example.org"}}"#
    let ipad = try JSONDecoder().decode(DistributorSettings.self, from: Data(old.utf8))
    let merged = DistributorSettings().reconciled(with: ipad)
    #expect(merged.createCombined)
    #expect(merged.destinations == [ Self.mac: "/Movies/TS" ])
    #expect(merged.version == DistributorSettings.currentVersion)
  }

  @Test("Each Mac's folder is its own group, so two Macs never overwrite each other")
  func foldersPerMac() {
    var ipad = DistributorSettings(destinations: [ Self.otherMac: "/Other" ])
    ipad.stamps[SettingsGroup.destination(mac: Self.otherMac).key] = SettingsStamp(modifiedAt: Self.at(50), by: Self.otherMac)
    var mac = DistributorSettings(destinations: [ Self.mac: "/Mine", Self.otherMac: "/Stale" ])
    mac.stamps[SettingsGroup.destination(mac: Self.mac).key] = SettingsStamp(modifiedAt: Self.at(10), by: Self.mac)
    let merged = mac.reconciled(with: ipad)
    #expect(merged.destinations == [ Self.mac: "/Mine", Self.otherMac: "/Other" ])
  }

  @Test("A TS Director that drops groups it does not know cannot take the Mac's away")
  func olderDirectorAnswer() {
    let before = DistributorSettings()
    var mac = before
    mac.combinedLayout = CombinedLayoutSettings(included: [ "Home", "Away" ], audioCamera: "Home")
    mac = mac.stampingChanges(from: before, by: Self.mac, at: Self.at(5))
    // What an older TS Director answers: its own groups, no stamps, nothing it does not know.
    let answered = DistributorSettings(createCombined: mac.createCombined)
    #expect(mac.reconciled(with: answered).combinedLayout == mac.combinedLayout)
  }

  @Test("Settings saved with a group this build no longer has still load, and are written without it")
  func retiredGroup() throws {
    // The shape a retired group was saved in: its block, and its stamp beside the others'.
    let saved = #"""
      {"version":2,"destinations":{"MAC-1":"/Movies/TS"},"createCombined":true,
       "upload":{"choice":{"primary":false,"cameras":["Home"],"combined":true}},
       "retiredGroup":{"teams":[{"id":"t1","publicID":"P1","name":"Titan"}]},
       "stamps":{"retiredGroup":{"modifiedAt":800000000,"by":"MAC-1"},
                 "createCombined":{"modifiedAt":800000000,"by":"ipad"},
                 "destination:MAC-1":{"modifiedAt":800000000,"by":"MAC-1"}}}
      """#
    let decoded = try JSONDecoder().decode(DistributorSettings.self, from: Data(saved.utf8))
    #expect(decoded.destinations == [ Self.mac: "/Movies/TS" ])
    #expect(decoded.createCombined)
    #expect(decoded.upload.choice == UploadChoice(primary: false, cameras: [ "Home" ], combined: true))
    #expect(Set(decoded.stamps.keys) == [ "createCombined", "destination:MAC-1" ])
    #expect(decoded.stamp(.createCombined)?.by == SettingsStamp.iPad)

    let written = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any])
    #expect(Set(written.keys) == [ "version", "destinations", "createCombined", "combinedLayout", "upload", "stamps" ])
    #expect(try JSONDecoder().decode(DistributorSettings.self, from: JSONEncoder().encode(decoded)) == decoded)
  }

  @Test("A stamp's key names its group, and a key no group has names none")
  func groupKeys() {
    for group in SettingsGroup.shared + [ .destination(mac: Self.mac) ] {
      #expect(SettingsGroup(key: group.key) == group)
    }
    #expect(SettingsGroup(key: "retiredGroup") == nil)
  }

  @Test("A folder cleared on the Mac stays cleared once brought together")
  func clearedFolder() {
    let ipad = DistributorSettings(destinations: [ Self.mac: "/Old" ])
    let mac = DistributorSettings(destinations: [ Self.mac: "/Old" ])
    var cleared = mac
    cleared.destinations[Self.mac] = nil
    let stamped = cleared.stampingChanges(from: mac, by: Self.mac, at: Self.at(1))
    #expect(stamped.reconciled(with: ipad).destinations.isEmpty)
  }

  @Test("New settings load with their defaults from a file written before them")
  func newGroupsDefault() throws {
    let decoded = try JSONDecoder().decode(DistributorSettings.self, from: Data(#"{"createCombined":true}"#.utf8))
    #expect(decoded.upload == UploadSettings())
    #expect(decoded.stamps.isEmpty)
  }
}
