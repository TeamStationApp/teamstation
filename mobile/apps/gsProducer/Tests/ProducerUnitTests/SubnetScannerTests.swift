import Foundation
import ProducerRTSP
import Testing

@Suite("Subnet scanning")
struct SubnetScannerTests {
  @Test("A /24 enumerates its 254 hosts and nothing else")
  func slash24() throws {
    let subnet = try #require(IPv4Subnet(address: "10.10.7.42", netmask: "255.255.255.0"))
    let hosts = try #require(subnet.hostAddresses())

    #expect(subnet.prefixLength == 24)
    #expect(subnet.cidrDescription == "10.10.7.0/24")
    // 254 usable addresses, less this device.
    #expect(hosts.count == 253)
    #expect(hosts.first == "10.10.7.1")
    #expect(hosts.last == "10.10.7.254")
  }

  @Test("The network, broadcast and this device's own address are not probed")
  func excludesNonHosts() throws {
    let subnet = try #require(IPv4Subnet(address: "192.168.1.10", netmask: "255.255.255.0"))
    let hosts = try #require(subnet.hostAddresses())

    #expect(!hosts.contains("192.168.1.0"))
    #expect(!hosts.contains("192.168.1.255"))
    #expect(!hosts.contains("192.168.1.10"))
  }

  @Test("A /22 is allowed, as the widest scan worth starting")
  func slash22IsTheLimit() throws {
    let subnet = try #require(IPv4Subnet(address: "10.10.4.7", netmask: "255.255.252.0"))
    let hosts = try #require(subnet.hostAddresses())

    #expect(subnet.prefixLength == 22)
    #expect(subnet.cidrDescription == "10.10.4.0/22")
    // 1022 usable addresses, less this device.
    #expect(hosts.count == 1_021)
  }

  @Test("Anything wider than /22 is refused rather than started")
  func refusesOversizedSubnets() throws {
    // A misconfigured mask would otherwise start a 65 000-host scan on a match day.
    let slash16 = try #require(IPv4Subnet(address: "10.10.7.42", netmask: "255.255.0.0"))
    #expect(slash16.hostAddresses() == nil)

    let slash8 = try #require(IPv4Subnet(address: "10.10.7.42", netmask: "255.0.0.0"))
    #expect(slash8.hostAddresses() == nil)
  }

  @Test("A single-host or point-to-point mask yields nothing to scan")
  func narrowSubnets() throws {
    let slash31 = try #require(IPv4Subnet(address: "10.0.0.1", netmask: "255.255.255.254"))
    #expect(slash31.hostAddresses() == nil)

    let slash30 = try #require(IPv4Subnet(address: "10.0.0.1", netmask: "255.255.255.252"))
    #expect(slash30.hostAddresses()?.isEmpty == false)
  }

  @Test("A malformed address or mask is rejected")
  func malformedInput() {
    #expect(IPv4Subnet(address: "10.10.7", netmask: "255.255.255.0") == nil)
    #expect(IPv4Subnet(address: "10.10.7.999", netmask: "255.255.255.0") == nil)
    #expect(IPv4Subnet(address: "10.10.7.1", netmask: "not-a-mask") == nil)
  }

  @Test("Hosts come back in address order, so the source list does not reshuffle between scans")
  func hostsAreOrdered() throws {
    let subnet = try #require(IPv4Subnet(address: "10.10.7.1", netmask: "255.255.255.0"))
    let hosts = try #require(subnet.hostAddresses())

    #expect(hosts == hosts.sorted { lhs, rhs in
      (IPv4Subnet.numeric(lhs) ?? 0) < (IPv4Subnet.numeric(rhs) ?? 0)
    })
  }
}
