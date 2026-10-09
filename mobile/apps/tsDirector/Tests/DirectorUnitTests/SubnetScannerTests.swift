import Foundation
import DirectorSources
import Network
import Testing

@Suite("Subnet scanning")
struct SubnetScannerTests {
  @Test("A /24 enumerates its 254 hosts and nothing else")
  func slash24() throws {
    let subnet = try #require(IPv4Subnet(address: "192.168.7.42", netmask: "255.255.255.0"))
    let hosts = try #require(subnet.hostAddresses())

    #expect(subnet.prefixLength == 24)
    #expect(subnet.cidrDescription == "192.168.7.0/24")
    // 254 usable addresses, less this device.
    #expect(hosts.count == 253)
    #expect(hosts.first == "192.168.7.1")
    #expect(hosts.last == "192.168.7.254")
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
    let subnet = try #require(IPv4Subnet(address: "192.168.4.7", netmask: "255.255.252.0"))
    let hosts = try #require(subnet.hostAddresses())

    #expect(subnet.prefixLength == 22)
    #expect(subnet.cidrDescription == "192.168.4.0/22")
    // 1022 usable addresses, less this device.
    #expect(hosts.count == 1_021)
  }

  @Test("Anything wider than /22 is refused rather than started")
  func refusesOversizedSubnets() throws {
    // A misconfigured mask would otherwise start a 65 000-host scan on a match day.
    let slash16 = try #require(IPv4Subnet(address: "192.168.7.42", netmask: "255.255.0.0"))
    #expect(slash16.hostAddresses() == nil)

    let slash8 = try #require(IPv4Subnet(address: "192.168.7.42", netmask: "255.0.0.0"))
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
    #expect(IPv4Subnet(address: "192.168.7.999", netmask: "255.255.255.0") == nil)
    #expect(IPv4Subnet(address: "192.168.7.1", netmask: "not-a-mask") == nil)
  }

  @Test("Hosts come back in address order, so the source list does not reshuffle between scans")
  func hostsAreOrdered() throws {
    let subnet = try #require(IPv4Subnet(address: "192.168.7.1", netmask: "255.255.255.0"))
    let hosts = try #require(subnet.hostAddresses())

    #expect(hosts == hosts.sorted { lhs, rhs in
      (IPv4Subnet.numeric(lhs) ?? 0) < (IPv4Subnet.numeric(rhs) ?? 0)
    })
  }

  @Test("Additional subnets are swept as well as the local one, never instead of it")
  func additionalSubnetsSupplementLocal() throws {
    let local = SubnetScanner.scanSubnets().map(\.cidrDescription)
    SubnetScanner.setOverrideSubnets(networkAddresses: ["198.51.100.0", "203.0.113.0"])
    defer { SubnetScanner.setOverrideSubnets(networkAddresses: []) }
    let subnets = SubnetScanner.scanSubnets().map(\.cidrDescription)
    #expect(subnets == local + ["198.51.100.0/24", "203.0.113.0/24"])
    SubnetScanner.setOverrideSubnets(networkAddresses: [])
    #expect(SubnetScanner.scanSubnets().map(\.cidrDescription) == local)
  }

  @Test("Local first, then each additional subnet; one equal to the local one is swept once")
  func unionOfLocalAndAdditional() throws {
    let local = try #require(IPv4Subnet(address: "198.51.100.42", netmask: "255.255.255.0"))
    let same = try #require(IPv4Subnet(address: "198.51.100.0", netmask: "255.255.255.0"))
    let other = try #require(IPv4Subnet(address: "203.0.113.0", netmask: "255.255.255.0"))

    let both = SubnetScanner.scanSubnets(local: local, additional: [same, other, other])
    #expect(both.map(\.cidrDescription) == ["198.51.100.0/24", "203.0.113.0/24"])
    // The local one is kept as it is, so this device stays out of its own sweep.
    #expect(both.first?.address == local.address)

    #expect(SubnetScanner.scanSubnets(local: local, additional: []).map(\.cidrDescription) == ["198.51.100.0/24"])
    #expect(SubnetScanner.scanSubnets(local: nil, additional: [other]).map(\.cidrDescription) == ["203.0.113.0/24"])
    #expect(SubnetScanner.scanSubnets(local: nil, additional: []).isEmpty)
  }

  @Test("A local /20 is skipped and said so, and the additional /24 is still swept")
  func tooWideSubnetIsSkippedNotTheSweep() throws {
    let venue = try #require(IPv4Subnet(address: "192.168.20.9", netmask: "255.255.240.0"))
    let additional = try #require(IPv4Subnet(address: "203.0.113.0", netmask: "255.255.255.0"))
    let plan = SubnetScanner.plan([venue, additional])
    #expect(plan.swept == ["203.0.113.0/24"])
    #expect(plan.skipped == ["192.168.16.0/20"])
    #expect(plan.hosts.count == 254)
    #expect(plan.diagnostic == "skipped 192.168.16.0/20: wider than /22")
    #expect(SubnetScanner.plan([additional]).diagnostic == nil)
  }

  @Test("Overlapping subnets sweep each host once, and never this device")
  func overlappingSubnets() throws {
    let local = try #require(IPv4Subnet(address: "192.168.40.7", netmask: "255.255.252.0"))
    let inside = try #require(IPv4Subnet(address: "192.168.40.0", netmask: "255.255.255.0"))
    let plan = SubnetScanner.plan([local, inside])
    #expect(plan.hosts.count == 1_021)
    #expect(!plan.hosts.contains("192.168.40.7"))
    #expect(Set(plan.hosts).count == plan.hosts.count)
  }

  @Test("Any probe refused by the Local Network permission reports it, even when routed hosts answer")
  func localNetworkDenial() {
    #expect(SubnetScanner.isLocalNetworkDenied(probes: 762, denied: 762))
    // The iPad's own subnet refused while an additional, routed subnet answered.
    #expect(SubnetScanner.isLocalNetworkDenied(probes: 762, denied: 254))
    #expect(!SubnetScanner.isLocalNetworkDenied(probes: 762, denied: 0))
    #expect(!SubnetScanner.isLocalNetworkDenied(probes: 0, denied: 0))
  }

  @Test("A sweep with only too-wide subnets probes nothing and says which it skipped")
  func scanReportsSkipped() async throws {
    let venue = try #require(IPv4Subnet(address: "192.168.20.9", netmask: "255.255.240.0"))
    let scanner = SubnetScanner(ports: [47614], subnets: { [venue] })
    let result = await scanner.scan()
    #expect(result.probedCount == 0)
    #expect(result.openHosts.isEmpty)
    #expect(result.subnet == "192.168.16.0/20")
    #expect(result.diagnostic == "skipped 192.168.16.0/20: wider than /22")
    #expect(!result.localNetworkDenied)

    let known = await scanner.probeKnown(["192.168.20.10"])
    #expect(known.probedCount == 0)
    #expect(known.diagnostic == "skipped 192.168.16.0/20: wider than /22")
  }

  @Test("No interface at all is said, rather than an empty sweep")
  func scanWithoutInterface() async {
    let scanner = SubnetScanner(ports: [554], subnets: { [] })
    #expect(await scanner.scan().diagnostic == "no IPv4 interface")
    #expect(await scanner.probeKnown(["192.0.2.1"]).diagnostic == "no IPv4 interface")
  }

  @Test("A sweep's ports can be given per sweep, and an open port is found on it")
  func scanFindsListenerOnGivenPort() async throws {
    let listener = try LoopbackListener()
    defer { listener.stop() }
    let port = try await listener.ready()
    let loopback = try #require(IPv4Subnet(address: "127.0.0.0", netmask: "255.255.255.252"))
    let scanner = SubnetScanner(ports: [9], timeout: 0.5, subnets: { [loopback] })

    let result = await scanner.scan(priority: ["127.0.0.1"], ports: [Int(port)])
    #expect(result.openHosts == ["127.0.0.1"])
    #expect(result.portsByHost["127.0.0.1"] == [Int(port)])
    #expect(result.hosts(onPort: Int(port)) == ["127.0.0.1"])
    #expect(result.restricted(to: [554]).openHosts.isEmpty)

    let known = await scanner.probeKnown(["127.0.0.1", "198.51.100.1"], ports: [Int(port)])
    #expect(known.openHosts == ["127.0.0.1"])
    #expect(known.probedCount == 1)
  }

  @Test("A port that cannot exist is reported closed, not probed")
  func impossiblePortIsClosed() async throws {
    let loopback = try #require(IPv4Subnet(address: "127.0.0.0", netmask: "255.255.255.252"))
    let scanner = SubnetScanner(ports: [70_000], timeout: 0.3, subnets: { [loopback] })
    let result = await scanner.probeKnown(["127.0.0.1"])
    #expect(result.openHosts.isEmpty)
  }
}

/// A TCP listener on the loopback interface, for a probe to find.
private final class LoopbackListener: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "test.loopback.listener")

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { connection in connection.cancel() }
  }

  func ready() async throws -> UInt16 {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
      let once = OnceFlag()
      listener.stateUpdateHandler = { [listener] state in
        switch state {
        case .ready:
          if once.claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
        case let .failed(error):
          if once.claim() { continuation.resume(throwing: error) }
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
  }

  func stop() { listener.cancel() }
}

private final class OnceFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func claim() -> Bool {
    lock.withLock {
      defer { claimed = true }
      return !claimed
    }
  }
}
