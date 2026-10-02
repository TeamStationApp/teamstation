import Foundation
import DirectorCore
import Testing

@Suite("AppConfig defaults")
struct AppConfigDefaultsTests {
  @Test("Programme master is HEVC with 3-second archive segments")
  func programmeAndSegmentDefaults() {
    let config = AppConfig()
    #expect(config.programCodec == .hevc)
    #expect(config.segmentSeconds == 3)
    #expect(config.streamURL == "")
  }

  @Test("A config saved before those keys existed loads the same defaults")
  func missingKeysUseDefaults() throws {
    let config = try JSONDecoder().decode(AppConfig.self, from: Data("{}".utf8))
    #expect(config.programCodec == .hevc)
    #expect(config.segmentSeconds == 3)
    #expect(config.streamURL == "")
  }

  @Test("The subnet scan override is off and empty by default, and older configs load that way")
  func subnetScanDefaults() throws {
    #expect(AppConfig().subnetScanOverrideEnabled == false)
    #expect(AppConfig().subnetScanOverride == "")
    #expect(AppConfig().activeScanSubnets.isEmpty)
    let old = try JSONDecoder().decode(AppConfig.self, from: Data(#"{"streamURL":"rtmp://x/live/y"}"#.utf8))
    #expect(old.subnetScanOverrideEnabled == false)
    #expect(old.subnetScanOverride == "")
    #expect(old.streamURL == "rtmp://x/live/y")
  }

  @Test("Both the subnet and its switch are saved, and the subnet is kept while the switch is off")
  func subnetScanPersists() throws {
    var config = AppConfig()
    config.subnetScanOverride = "10.10.6.0"
    config.subnetScanOverrideEnabled = true
    let on = try JSONDecoder().decode(AppConfig.self, from: JSONEncoder().encode(config))
    #expect(on.subnetScanOverrideEnabled)
    #expect(on.activeScanSubnets == ["10.10.6.0"])
    config.subnetScanOverrideEnabled = false
    let off = try JSONDecoder().decode(AppConfig.self, from: JSONEncoder().encode(config))
    #expect(off.subnetScanOverride == "10.10.6.0")
    #expect(off.activeScanSubnets.isEmpty)
  }

  @Test("A typed subnet becomes its /24's network address, and anything else is refused")
  func subnetScanParsing() {
    #expect(AppConfig.scanSubnetNetworkAddress("10.10.6.0") == "10.10.6.0")
    #expect(AppConfig.scanSubnetNetworkAddress(" 10.10.6.25 ") == "10.10.6.0")
    #expect(AppConfig.scanSubnetNetworkAddress("10.10.6.0/24") == "10.10.6.0")
    #expect(AppConfig.scanSubnetNetworkAddress("10.10.6") == nil)
    #expect(AppConfig.scanSubnetNetworkAddress("10.10.256.0") == nil)
    #expect(AppConfig.scanSubnetNetworkAddress("") == nil)
  }

  @Test("Two subnets may be named, comma-separated; a third, or a bad one, refuses them all")
  func twoScanSubnets() {
    #expect(AppConfig.scanSubnetNetworkAddresses("10.10.6.0, 10.10.7.0") == ["10.10.6.0", "10.10.7.0"])
    #expect(AppConfig.scanSubnetNetworkAddresses("10.10.6.0,10.10.6.9") == ["10.10.6.0"])
    #expect(AppConfig.scanSubnetNetworkAddresses("10.10.6.0, 10.10.7.0, 10.10.8.0") == nil)
    #expect(AppConfig.scanSubnetNetworkAddresses("10.10.6.0, nonsense") == nil)
    var config = AppConfig(subnetScanOverrideEnabled: true, subnetScanOverride: "10.10.6.0, 10.10.7.0")
    #expect(config.activeScanSubnets == ["10.10.6.0", "10.10.7.0"])
    config.subnetScanOverrideEnabled = false
    #expect(config.activeScanSubnets.isEmpty)
  }
}

@Suite("Where the Stream button publishes")
struct StreamDestinationTests {
  @Test("A Director that has always typed a URL keeps typing one")
  func defaultsToTheTypedURL() {
    // Every Director already in the field has a URL in Settings and no idea
    // what a TeamStation event is. Anything but `.url` here would move where
    // their Stream button publishes the next time they open the app.
    #expect(AppConfig().streamDestination == .url)
  }

  @Test("A settings file written before events existed reads as the typed URL")
  func olderConfigsKeepTheirURL() throws {
    let old = try JSONDecoder().decode(
      AppConfig.self,
      from: Data(#"{"streamURL":"rtmp://host:1935/live/key"}"#.utf8)
    )
    #expect(old.streamDestination == .url)
    #expect(old.streamURL == "rtmp://host:1935/live/key")
  }

  @Test("A saved address left over from when it was a setting is ignored")
  func theOldSavedAddressIsNotRead() throws {
    // Every Director in the field has one of these on disk. The address comes
    // from the build now, so the key is simply not a key any more.
    let stale = try JSONDecoder().decode(
      AppConfig.self,
      from: Data(#"{"teamStationURL":"https://tube2.gamestation.co"}"#.utf8)
    )
    #expect(stale.streamDestination == .url)
  }

  @Test("The choice and the URL both survive a save")
  func destinationPersists() throws {
    var config = AppConfig()
    config.streamDestination = .event
    config.streamURL = "rtmp://host:1935/live/key"

    let saved = try JSONDecoder().decode(
      AppConfig.self,
      from: JSONEncoder().encode(config)
    )
    #expect(saved.streamDestination == .event)
    // The typed URL is kept while the event is chosen: switching back should
    // not mean typing it again.
    #expect(saved.streamURL == "rtmp://host:1935/live/key")
  }

  @Test("An unreadable choice falls back rather than failing the whole file")
  func nonsenseDestinationFallsBack() throws {
    // One bad key must not cost somebody every other setting they have.
    let odd = try JSONDecoder().decode(
      AppConfig.self,
      from: Data(#"{"streamDestination":"carrier-pigeon","programBitrate":9000000}"#.utf8)
    )
    #expect(odd.streamDestination == .url)
    #expect(odd.programBitrate == 9_000_000)
  }
}
