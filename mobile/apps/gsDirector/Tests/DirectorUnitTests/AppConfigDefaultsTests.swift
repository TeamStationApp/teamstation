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
    config.subnetScanOverride = "192.168.6.0"
    config.subnetScanOverrideEnabled = true
    let on = try JSONDecoder().decode(AppConfig.self, from: JSONEncoder().encode(config))
    #expect(on.subnetScanOverrideEnabled)
    #expect(on.activeScanSubnets == ["192.168.6.0"])
    config.subnetScanOverrideEnabled = false
    let off = try JSONDecoder().decode(AppConfig.self, from: JSONEncoder().encode(config))
    #expect(off.subnetScanOverride == "192.168.6.0")
    #expect(off.activeScanSubnets.isEmpty)
  }

  @Test("A typed subnet becomes its /24's network address, and anything else is refused")
  func subnetScanParsing() {
    #expect(AppConfig.scanSubnetNetworkAddress("192.168.6.0") == "192.168.6.0")
    #expect(AppConfig.scanSubnetNetworkAddress(" 192.168.6.25 ") == "192.168.6.0")
    #expect(AppConfig.scanSubnetNetworkAddress("192.168.6.0/24") == "192.168.6.0")
    #expect(AppConfig.scanSubnetNetworkAddress("10.10.6") == nil)
    #expect(AppConfig.scanSubnetNetworkAddress("192.168.256.0") == nil)
    #expect(AppConfig.scanSubnetNetworkAddress("") == nil)
  }

  @Test("Two subnets may be named, comma-separated; a third, or a bad one, refuses them all")
  func twoScanSubnets() {
    #expect(AppConfig.scanSubnetNetworkAddresses("192.168.6.0, 192.168.7.0") == ["192.168.6.0", "192.168.7.0"])
    #expect(AppConfig.scanSubnetNetworkAddresses("192.168.6.0,192.168.6.9") == ["192.168.6.0"])
    #expect(AppConfig.scanSubnetNetworkAddresses("192.168.6.0, 192.168.7.0, 192.168.8.0") == nil)
    #expect(AppConfig.scanSubnetNetworkAddresses("192.168.6.0, nonsense") == nil)
    var config = AppConfig(subnetScanOverrideEnabled: true, subnetScanOverride: "192.168.6.0, 192.168.7.0")
    #expect(config.activeScanSubnets == ["192.168.6.0", "192.168.7.0"])
    config.subnetScanOverrideEnabled = false
    #expect(config.activeScanSubnets.isEmpty)
  }
}
