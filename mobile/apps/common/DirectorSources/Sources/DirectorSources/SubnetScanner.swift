import Foundation
import Network
import os

/// An IPv4 network worked out from an interface's address and mask.
public struct IPv4Subnet: Sendable, Equatable {
  /// A /22 is 1022 hosts, which finishes in a few seconds at 32 concurrent probes. Anything wider
  /// is refused: a misconfigured mask would otherwise start a 65 000-host scan on a match day.
  public static let widestAllowedPrefix = 22

  public let address: UInt32
  public let mask: UInt32

  public init(address: UInt32, mask: UInt32) {
    self.address = address
    self.mask = mask
  }

  public init?(address: String, netmask: String) {
    guard
      let address = Self.parse(address),
      let mask = Self.parse(netmask)
    else { return nil }
    self.address = address
    self.mask = mask
  }

  public var prefixLength: Int { mask.nonzeroBitCount }
  public var networkAddress: UInt32 { address & mask }
  public var broadcastAddress: UInt32 { networkAddress | ~mask }
  public var hostCount: Int { max(0, Int(broadcastAddress - networkAddress) - 1) }
  public var cidrDescription: String { "\(Self.string(networkAddress))/\(prefixLength)" }

  /// Every address worth probing: the network and broadcast addresses are not hosts, and this
  /// device is not a camera.
  public func hostAddresses() -> [String]? {
    guard prefixLength >= Self.widestAllowedPrefix, prefixLength <= 30 else { return nil }
    var result: [String] = []
    result.reserveCapacity(hostCount)
    var candidate = networkAddress + 1
    while candidate < broadcastAddress {
      if candidate != address { result.append(Self.string(candidate)) }
      candidate += 1
    }
    return result
  }

  /// Numeric form of a dotted-quad address. Scans are published in this order so the source list
  /// does not reshuffle between sweeps.
  public static func numeric(_ text: String) -> UInt32? { parse(text) }

  static func parse(_ text: String) -> UInt32? {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var value: UInt32 = 0
    for part in parts {
      guard let octet = UInt8(part) else { return nil }
      value = (value << 8) | UInt32(octet)
    }
    return value
  }

  static func string(_ value: UInt32) -> String {
    "\((value >> 24) & 0xFF).\((value >> 16) & 0xFF).\((value >> 8) & 0xFF).\(value & 0xFF)"
  }
}

/// Finds hosts with an open port on this device's subnet and on any additional subnets configured.
///
/// A scan rather than a browse because these cameras advertise nothing: no mDNS, no ONVIF, no
/// discovery protocol of any kind. Their address is the only thing about them that is findable, and
/// it comes from DHCP.
public final class SubnetScanner: @unchecked Sendable {
  public struct Result: Sendable {
    public let openHosts: [String]
    public let probedCount: Int
    public let subnet: String
    /// Why nothing was scanned, or which subnets were left out, when that is the case.
    public let diagnostic: String?
    /// Which of the requested ports answered, per host. A host appears in `openHosts` if any did.
    public let portsByHost: [String: Set<Int>]
    /// The system's Local Network permission refused probes, so this app cannot reach its own
    /// subnet and an empty answer says nothing about the network. See `isLocalNetworkDenied`.
    public let localNetworkDenied: Bool
    /// Every port the sweep asked any host about. Empty when the sweep does not say (a result made
    /// by hand); a sweep whose ports changed part-way through asked about more than it began with.
    public let askedPorts: Set<Int>

    public init(
      openHosts: [String],
      probedCount: Int,
      subnet: String,
      diagnostic: String?,
      portsByHost: [String: Set<Int>] = [:],
      localNetworkDenied: Bool = false,
      askedPorts: Set<Int> = []
    ) {
      self.openHosts = openHosts
      self.probedCount = probedCount
      self.subnet = subnet
      self.diagnostic = diagnostic
      self.portsByHost = portsByHost
      self.localNetworkDenied = localNetworkDenied
      self.askedPorts = askedPorts
    }

    /// Hosts that answered on one specific port.
    public func hosts(onPort port: Int) -> [String] {
      portsByHost.filter { $0.value.contains(port) }.keys
        .sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) }
    }

    /// The same sweep with only the answers on `ports`: a host that answered on none of them is
    /// left out. How one sweep's answer is shared between consumers that each asked about their
    /// own ports, so none of them sees another's.
    public func restricted(to ports: Set<Int>) -> Result {
      let kept = portsByHost.compactMapValues { answered -> Set<Int>? in
        let mine = answered.intersection(ports)
        return mine.isEmpty ? nil : mine
      }
      return Result(
        openHosts: kept.keys.sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) },
        probedCount: probedCount,
        subnet: subnet,
        diagnostic: diagnostic,
        portsByHost: kept,
        localNetworkDenied: localNetworkDenied,
        askedPorts: askedPorts.intersection(ports)
      )
    }
  }

  /// What one sweep covers: every host of the subnets that may be swept, in order and without
  /// repeats, and the subnets left out for being wider than `IPv4Subnet.widestAllowedPrefix`.
  public struct Plan: Sendable, Equatable {
    public let hosts: [String]
    public let swept: [String]
    public let skipped: [String]

    /// "skipped 192.168.16.0/20: wider than /22", or nil when nothing was skipped.
    public var diagnostic: String? {
      guard !skipped.isEmpty else { return nil }
      return skipped
        .map { "skipped \($0): wider than /\(IPv4Subnet.widestAllowedPrefix)" }
        .joined(separator: "; ")
    }
  }

  /// One subnet too wide to sweep leaves out that subnet only, so a venue's /20 on Wi-Fi does not
  /// hide the configured /24s beside it.
  public static func plan(_ subnets: [IPv4Subnet]) -> Plan {
    var hosts: [String] = []
    // This device is not a host to probe, even inside an additional subnet that overlaps its own.
    var seen = Set(subnets.filter { $0.address != $0.networkAddress }.map { IPv4Subnet.string($0.address) })
    var swept: [String] = []
    var skipped: [String] = []
    for subnet in subnets {
      guard let addresses = subnet.hostAddresses() else {
        skipped.append(subnet.cidrDescription)
        continue
      }
      swept.append(subnet.cidrDescription)
      for address in addresses where seen.insert(address).inserted {
        hosts.append(address)
      }
    }
    return Plan(hosts: hosts, swept: swept, skipped: skipped)
  }

  /// One sweep's plan, made again only when the subnets it is read from change: the subnets are
  /// read before every batch, and a /24's host list rebuilt for each five addresses would be
  /// fifty lists of 253 strings per subnet per sweep.
  struct PlanCache {
    private var subnets: [IPv4Subnet]?
    private var plan = Plan(hosts: [], swept: [], skipped: [])
    /// How many plans were made, for tests.
    private(set) var builds = 0

    mutating func plan(for current: [IPv4Subnet]) -> Plan {
      if current != subnets {
        subnets = current
        plan = SubnetScanner.plan(current)
        builds += 1
      }
      return plan
    }
  }

  /// What probing one port of one address found.
  public enum ProbeAnswer: Sendable, Equatable {
    case open
    case closed
    /// The system would not let this app reach the local network.
    case denied
  }

  /// Asks one address about one port.
  public typealias Probe = @Sendable (_ host: String, _ port: Int) async -> ProbeAnswer

  private let ports: [Int]
  private let timeout: TimeInterval
  private let concurrency: Int
  private let subnets: @Sendable () -> [IPv4Subnet]
  private let gapMilliseconds: Int
  private var probeOne: Probe!
  /// Plans made by the last sweep, for tests.
  let lastScanPlanBuilds = OSAllocatedUnfairLock(initialState: 0)
  /// Addresses probed together once the known ones are out of the way.
  public static let pacedBatchSize = 5
  /// Left between those batches. Five every 200 ms is a /24 in about ten seconds.
  public static let pacedGapMilliseconds = 200
  /// How many times a sweep goes back over the addresses it has passed for ports or subnets added
  /// while it ran, before leaving the rest to the next sweep.
  static let catchUpRounds = 3

  public convenience init(port: Int = 554, timeout: TimeInterval = 0.3, concurrency: Int = 32) {
    self.init(ports: [port], timeout: timeout, concurrency: concurrency)
  }

  /// Several ports in one pass over the subnet.
  ///
  /// Worth doing rather than one sweep per protocol: nearly every address on a /24 has no host, and
  /// the cost of probing one is an ARP broadcast that every device on the segment must process.
  /// ARP resolves per address, not per port, so asking one address about NDI and RTSP together
  /// costs the same broadcast as asking about either alone — measured at 221 of 253 addresses
  /// empty on this network, so combining halves the sweep's real cost.
  ///
  /// The ports of one address are asked at the same time, not one after another: the address's one
  /// ARP resolution serves all of them, so a sweep asking five ports costs what one asking three
  /// does, about one connect timeout per batch of addresses.
  ///
  /// `subnets` is what a sweep covers, read before every batch: `scanSubnets()` unless a test says
  /// otherwise. `probe` and `gapMilliseconds` are for tests that sweep without a network.
  public init(
    ports: [Int],
    timeout: TimeInterval = 0.3,
    concurrency: Int = 32,
    subnets: @escaping @Sendable () -> [IPv4Subnet] = { SubnetScanner.scanSubnets() },
    gapMilliseconds: Int = SubnetScanner.pacedGapMilliseconds,
    probe: Probe? = nil
  ) {
    self.ports = ports.isEmpty ? [554] : ports
    self.timeout = timeout
    self.concurrency = concurrency
    self.subnets = subnets
    self.gapMilliseconds = gapMilliseconds
    probeOne = probe
    if probeOne == nil {
      probeOne = { [unowned self] host, port in await self.isOpen(host: host, port: port) }
    }
  }

  /// Addresses worth trying before the rest of the segment, newest first.
  ///
  /// A camera that dropped is nearly always still on the address it was last seen at, so probing
  /// that one first turns the common case into a single packet instead of a segment-wide sweep.
  ///
  /// `ports` replaces the ports this scanner was made with for this one sweep, for a sweeper whose
  /// ports change between sweeps.
  public func scan(priority: [String] = [], ports: [Int]? = nil) async -> Result {
    let asked = ports ?? self.ports
    return await scan(priority: priority, portsNow: { asked })
  }

  /// One sweep whose ports and subnets may change while it runs.
  ///
  /// `portsNow` and the subnets are read again before every batch, so a port or a subnet added
  /// part-way through (device event control turned on, a sign-in, a subnet added in Settings) is
  /// asked of every address still to come, and one removed (recording started) is asked of none of
  /// them. When the pass ends, the addresses it went past before the change are asked about the
  /// ports they missed, and addresses of a subnet added late are swept, paced the same way, so the
  /// change takes effect in this sweep rather than waiting for a whole next one. A port no longer
  /// wanted by then is not caught up.
  public func scan(priority: [String], portsNow: @escaping @Sendable () -> [Int]) async -> Result {
    let initial = self.subnets()
    guard !initial.isEmpty else {
      return Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: "no IPv4 interface")
    }
    var asked: [String: Set<Int>] = [:]
    var outcome = Probed()
    var plans = PlanCache()
    defer { lastScanPlanBuilds.withLock { [builds = plans.builds] in $0 = builds } }

    // Known addresses first and without pacing, then everything else gently.
    let known = priority.filter { IPv4Subnet.parse($0) != nil }
    if !known.isEmpty {
      let ports = portsNow()
      if !ports.isEmpty {
        outcome.merge(await probe(hosts: known, ports: ports, paced: false))
        for host in known { asked[host, default: []].formUnion(ports) }
      }
    }

    // The pass: each batch is the next addresses not yet asked, about the ports wanted now. The
    // hosts before `next` have all been asked, so each batch carries on from there; a change of
    // subnets starts the walk over the new plan from its first host.
    var batches = 0
    var walking = 0
    var next = 0
    while true {
      let ports = portsNow()
      guard !ports.isEmpty else { break }
      let hosts = plans.plan(for: subnets()).hosts
      if plans.builds != walking {
        walking = plans.builds
        next = 0
      }
      var batch: [String] = []
      while next < hosts.count, batch.count < Self.pacedBatchSize {
        if asked[hosts[next]] == nil { batch.append(hosts[next]) }
        next += 1
      }
      guard !batch.isEmpty else { break }
      if batches > 0 { try? await Task.sleep(for: .milliseconds(gapMilliseconds)) }
      batches += 1
      outcome.merge(await probe(hosts: batch, ports: ports, paced: false))
      for host in batch { asked[host] = Set(ports) }
    }

    // Catching up: what the pass went past before a port or subnet was added.
    for _ in 0 ..< Self.catchUpRounds {
      let wanted = Set(portsNow())
      let hosts = plans.plan(for: subnets()).hosts + known.filter { asked[$0] != nil }
      var missing: [Set<Int>: [String]] = [:]
      for host in hosts {
        let gap = wanted.subtracting(asked[host] ?? [])
        if !gap.isEmpty { missing[gap, default: []].append(host) }
      }
      guard !missing.isEmpty else { break }
      for (gap, hosts) in missing {
        let ports = gap.sorted()
        outcome.merge(await probe(hosts: hosts, ports: ports, paced: true))
        for host in hosts { asked[host, default: []].formUnion(gap) }
      }
    }

    let latest = self.subnets()
    let subnets = latest.isEmpty ? initial : latest
    let plan = plans.plan(for: subnets)
    return Result(
      openHosts: outcome.open.keys.sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) },
      probedCount: plan.hosts.count,
      subnet: subnets.map(\.cidrDescription).joined(separator: ","),
      diagnostic: plan.diagnostic,
      portsByHost: outcome.open,
      localNetworkDenied: Self.isLocalNetworkDenied(probes: outcome.probes, denied: outcome.denied),
      askedPorts: asked.values.reduce(into: Set<Int>()) { $0.formUnion($1) }
    )
  }

  /// Whether a sweep's probes show the Local Network permission is off: any probe the system
  /// refused for it. The permission is the app's, not a host's, and covers only the subnets this
  /// device is on: with additional subnets configured, their hosts are routed and still answer
  /// while every host on the iPad's own subnet is refused, so "every probe refused" would never
  /// hold and the denial would go unreported.
  public static func isLocalNetworkDenied(probes: Int, denied: Int) -> Bool {
    probes > 0 && denied > 0
  }

  /// Only the given addresses, unpaced, and nothing else on the segment.
  ///
  /// For launch: the cameras are almost always where they were last time, and asking one or two
  /// known hosts directly is a handful of unicast packets where a sweep is an ARP broadcast per
  /// empty address. Addresses outside the swept subnets are dropped rather than probed, since a
  /// lease from another network is not a camera on this one.
  public func probeKnown(_ addresses: [String], ports: [Int]? = nil) async -> Result {
    let subnets = self.subnets()
    guard !subnets.isEmpty else {
      return Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: "no IPv4 interface")
    }
    let plan = Self.plan(subnets)
    let local = Set(plan.hosts)
    let known = addresses.filter { local.contains($0) }
    let outcome = known.isEmpty ? Probed() : await probe(hosts: known, ports: ports ?? self.ports, paced: false)
    return Result(
      openHosts: outcome.open.keys.sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) },
      probedCount: known.count,
      subnet: subnets.map(\.cidrDescription).joined(separator: ","),
      diagnostic: plan.diagnostic,
      portsByHost: outcome.open,
      localNetworkDenied: Self.isLocalNetworkDenied(probes: outcome.probes, denied: outcome.denied),
      askedPorts: known.isEmpty ? [] : Set(ports ?? self.ports)
    )
  }

  /// What a batch of probes found, and how many the system refused.
  private struct Probed {
    var open: [String: Set<Int>] = [:]
    var probes = 0
    var denied = 0

    /// A host asked twice (caught up on a port it missed) keeps what it answered both times.
    mutating func merge(_ other: Probed) {
      for (host, ports) in other.open { open[host, default: []].formUnion(ports) }
      probes += other.probes
      denied += other.denied
    }
  }

  /// Probes in bounded batches. Opening a thousand sockets at once exhausts the process's file
  /// descriptors, and the failures look exactly like closed ports.
  private func probe(hosts: [String], ports: [Int], paced: Bool) async -> Probed {
    var outcome = Probed()
    var index = 0
    let size = paced ? Self.pacedBatchSize : concurrency

    while index < hosts.count {
      let batch = hosts[index ..< min(index + size, hosts.count)]
      index += batch.count
      // Spread out rather than fired at once. Every probe of an empty address is an ARP broadcast
      // that every device on the segment must process, cameras included, and a segment-wide sweep
      // delivered as fast as the sockets allow was measured stalling a camera's delivery for over
      // a second. Paced, a /24 takes about ten seconds and nothing else notices.
      if paced, index > batch.count {
        try? await Task.sleep(for: .milliseconds(gapMilliseconds))
      }

      let found = await withTaskGroup(of: (String, Set<Int>, Int, Int).self) { group in
        for host in batch {
          group.addTask { [self] in
            let (open, probes, denied) = await openPorts(host: host, ports: ports)
            return (host, open, probes, denied)
          }
        }
        var results: [(String, Set<Int>, Int, Int)] = []
        for await result in group { results.append(result) }
        return results
      }
      for (host, open, probes, denied) in found {
        if !open.isEmpty { outcome.open[host] = open }
        outcome.probes += probes
        outcome.denied += denied
      }
    }
    return outcome
  }

  /// Every requested port on one address, at the same time. The address is resolved once whatever
  /// the number of ports — the first connect starts the ARP request and the others wait on the same
  /// entry — so an empty address costs one connect timeout rather than one per port. Asked one
  /// after another, as they were, each port of an empty address waited out its own timeout, which
  /// is what made adding ports lengthen the sweep.
  private func openPorts(host: String, ports: [Int]) async -> (Set<Int>, probes: Int, denied: Int) {
    let probeOne = self.probeOne!
    return await withTaskGroup(of: (Int, ProbeAnswer).self) { group in
      for port in ports {
        group.addTask { (port, await probeOne(host, port)) }
      }
      var answered: Set<Int> = []
      var denied = 0
      for await (port, answer) in group {
        switch answer {
        case .open: answered.insert(port)
        case .closed: break
        case .denied: denied += 1
        }
      }
      return (answered, ports.count, denied)
    }
  }

  func isOpen(host: String, port rawPort: Int) async -> ProbeAnswer {
    guard let port = UInt16(exactly: rawPort).flatMap(NWEndpoint.Port.init(rawValue:)) else {
      return .closed
    }

    return await withCheckedContinuation { continuation in
      let parameters = NWParameters.tcp
      parameters.includePeerToPeer = true
      if let options = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
        options.connectionTimeout = Int(timeout.rounded(.up))
      }
      let connection = NWConnection(
        host: NWEndpoint.Host(host),
        port: port,
        using: parameters
      )
      // `NWConnection` reports both success and failure exactly once, but a resumed continuation
      // must not be resumed again, and a deadline may race the state handler.
      let hasResumed = OSAllocatedUnfairLock(initialState: false)
      let finish: @Sendable (ProbeAnswer) -> Void = { answer in
        let shouldResume = hasResumed.withLock { resumed -> Bool in
          guard !resumed else { return false }
          resumed = true
          return true
        }
        guard shouldResume else { return }
        connection.cancel()
        continuation.resume(returning: answer)
      }

      connection.stateUpdateHandler = { state in
        switch state {
        case .ready:
          finish(.open)
        case .failed, .cancelled:
          finish(.closed)
        case .waiting where connection.currentPath?.unsatisfiedReason == .localNetworkDenied:
          // Not the network's answer but the system's: this app may not use the local network.
          finish(.denied)
        default:
          // `.waiting` is how an iPhone RTSP listener starts. Treating it as closed is why a
          // subnet scan found NearStream boxes and never TS Cameraman.
          break
        }
      }
      connection.start(queue: Self.probeQueue)
      Self.probeQueue.asyncAfter(deadline: .now() + timeout) { finish(.closed) }
    }
  }

  private static let probeQueue = DispatchQueue(
    label: "app.teamstation.director.rtsp.scan",
    attributes: .concurrent
  )

  /// Additional /24s to sweep, set from Settings. Empty sweeps this device's own subnet alone.
  private static let additionalSubnets = OSAllocatedUnfairLock<[IPv4Subnet]>(initialState: [])

  /// Sweeps the /24s whose network addresses these are (`198.51.100.0`) in addition to this device's
  /// own subnet; empty sweeps the local subnet alone. Every scanner reads them at the start of each
  /// sweep.
  public static func setOverrideSubnets(networkAddresses: [String]) {
    let subnets = networkAddresses.compactMap { IPv4Subnet(address: $0, netmask: "255.255.255.0") }
    additionalSubnets.withLock { $0 = subnets }
  }

  /// What a sweep covers: this device's own subnet and every additional subnet set in Settings.
  /// The additional subnets supplement the local one; they never replace it.
  public static func scanSubnets() -> [IPv4Subnet] {
    scanSubnets(local: localSubnet(), additional: additionalSubnets.withLock { $0 })
  }

  /// The local subnet first, then each additional one, each network once: an additional subnet that
  /// is the local one is swept once, as the local one.
  public static func scanSubnets(local: IPv4Subnet?, additional: [IPv4Subnet]) -> [IPv4Subnet] {
    var result: [IPv4Subnet] = []
    for subnet in (local.map { [$0] } ?? []) + additional
    where !result.contains(where: { $0.cidrDescription == subnet.cidrDescription }) {
      result.append(subnet)
    }
    return result
  }

  /// The subnet to scan: the Wi-Fi interface's on a device, where it is `en0`. The simulator
  /// inherits the Mac's interfaces instead, which is what lets a simulator run reach the real
  /// cameras, so any other configured interface is accepted as a fallback.
  static func localSubnet(preferring names: [String] = [ "en0", "en1" ]) -> IPv4Subnet? {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let head else { return nil }
    defer { freeifaddrs(head) }

    var candidates: [String: IPv4Subnet] = [:]
    var pointer: UnsafeMutablePointer<ifaddrs>? = head
    while let current = pointer {
      defer { pointer = current.pointee.ifa_next }

      guard
        let addressPointer = current.pointee.ifa_addr,
        addressPointer.pointee.sa_family == UInt8(AF_INET),
        let maskPointer = current.pointee.ifa_netmask,
        current.pointee.ifa_flags & UInt32(IFF_UP) != 0,
        current.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0
      else { continue }

      let name = String(cString: current.pointee.ifa_name)
      let address = addressPointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
        UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
      }
      let mask = maskPointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
        UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
      }
      // A 169.254 address means this interface never got a lease. Nothing is reachable on it, and
      // its /16 would be refused as too wide anyway.
      guard address & 0xFFFF_0000 != 0xA9FE_0000 else { continue }
      candidates[name] = IPv4Subnet(address: address, mask: mask)
    }

    for name in names {
      if let subnet = candidates[name] { return subnet }
    }
    return candidates.sorted { $0.key < $1.key }.first?.value
  }
}
