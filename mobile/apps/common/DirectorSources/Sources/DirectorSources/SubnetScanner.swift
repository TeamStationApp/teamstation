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

/// Finds hosts with an open RTSP port on the Wi-Fi subnet.
///
/// A scan rather than a browse because these cameras advertise nothing: no mDNS, no ONVIF, no
/// discovery protocol of any kind. Their address is the only thing about them that is findable, and
/// it comes from DHCP.
public final class SubnetScanner: @unchecked Sendable {
  public struct Result: Sendable {
    public let openHosts: [String]
    public let probedCount: Int
    public let subnet: String
    /// Why nothing was scanned, when that is the case.
    public let diagnostic: String?
    /// Which of the requested ports answered, per host. A host appears in `openHosts` if any did.
    public let portsByHost: [String: Set<Int>]

    public init(
      openHosts: [String],
      probedCount: Int,
      subnet: String,
      diagnostic: String?,
      portsByHost: [String: Set<Int>] = [:]
    ) {
      self.openHosts = openHosts
      self.probedCount = probedCount
      self.subnet = subnet
      self.diagnostic = diagnostic
      self.portsByHost = portsByHost
    }

    /// Hosts that answered on one specific port.
    public func hosts(onPort port: Int) -> [String] {
      portsByHost.filter { $0.value.contains(port) }.keys
        .sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) }
    }
  }

  private let ports: [Int]
  private let timeout: TimeInterval
  private let concurrency: Int
  /// Addresses probed together once the known ones are out of the way.
  public static let pacedBatchSize = 5
  /// Left between those batches. Five every 200 ms is a /24 in about ten seconds.
  public static let pacedGapMilliseconds = 200

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
  public init(ports: [Int], timeout: TimeInterval = 0.3, concurrency: Int = 32) {
    self.ports = ports.isEmpty ? [554] : ports
    self.timeout = timeout
    self.concurrency = concurrency
  }

  /// Addresses worth trying before the rest of the segment, newest first.
  ///
  /// A camera that dropped is nearly always still on the address it was last seen at, so probing
  /// that one first turns the common case into a single packet instead of a segment-wide sweep.
  public func scan(priority: [String] = []) async -> Result {
    let subnets = Self.scanSubnets()
    guard !subnets.isEmpty else {
      return Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: "no IPv4 interface")
    }
    let described = subnets.map(\.cidrDescription).joined(separator: ",")
    var hosts: [String] = []
    for subnet in subnets {
      guard let addresses = subnet.hostAddresses() else {
        return Result(
          openHosts: [],
          probedCount: 0,
          subnet: described,
          diagnostic: "refusing to scan \(subnet.cidrDescription): wider than /\(IPv4Subnet.widestAllowedPrefix)"
        )
      }
      hosts += addresses.filter { !hosts.contains($0) }
    }

    // Known addresses first and without pacing, then everything else gently.
    let known = priority.filter { IPv4Subnet.parse($0) != nil }
    let seen = Set(known)
    let rest = hosts.filter { !seen.contains($0) }
    var open = known.isEmpty ? [:] : await probe(hosts: known, paced: false)
    for (host, ports) in await probe(hosts: rest, paced: true) { open[host] = ports }
    return Result(
      openHosts: open.keys.sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) },
      probedCount: hosts.count,
      subnet: described,
      diagnostic: nil,
      portsByHost: open
    )
  }

  /// Only the given addresses, unpaced, and nothing else on the segment.
  ///
  /// For launch: the cameras are almost always where they were last time, and asking one or two
  /// known hosts directly is a handful of unicast packets where a sweep is an ARP broadcast per
  /// empty address. Addresses outside the local subnet are dropped rather than probed, since a
  /// lease from another network is not a camera on this one.
  public func probeKnown(_ addresses: [String]) async -> Result {
    let subnets = Self.scanSubnets()
    guard !subnets.isEmpty else {
      return Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: "no IPv4 interface")
    }
    let local = Set(subnets.flatMap { $0.hostAddresses() ?? [] })
    let known = addresses.filter { local.contains($0) }
    let open = known.isEmpty ? [:] : await probe(hosts: known, paced: false)
    return Result(
      openHosts: open.keys.sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) },
      probedCount: known.count,
      subnet: subnets.map(\.cidrDescription).joined(separator: ","),
      diagnostic: nil,
      portsByHost: open
    )
  }

  /// Probes in bounded batches. Opening a thousand sockets at once exhausts the process's file
  /// descriptors, and the failures look exactly like closed ports.
  private func probe(hosts: [String], paced: Bool) async -> [String: Set<Int>] {
    var open: [String: Set<Int>] = [:]
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
        try? await Task.sleep(for: .milliseconds(Self.pacedGapMilliseconds))
      }

      let found = await withTaskGroup(of: (String, Set<Int>).self) { group in
        for host in batch {
          group.addTask { [self] in (host, await openPorts(host: host)) }
        }
        var results: [(String, Set<Int>)] = []
        for await result in group {
          if !result.1.isEmpty { results.append(result) }
        }
        return results
      }
      for (host, ports) in found { open[host] = ports }
    }
    return open
  }

  /// Every requested port on one address, probed one after another so the address is resolved once.
  private func openPorts(host: String) async -> Set<Int> {
    var answered: Set<Int> = []
    for port in ports where await isOpen(host: host, port: port) {
      answered.insert(port)
    }
    return answered
  }

  private func isOpen(host: String, port rawPort: Int) async -> Bool {
    guard let port = NWEndpoint.Port(rawValue: UInt16(rawPort)) else { return false }

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
      let finish: @Sendable (Bool) -> Void = { isOpen in
        let shouldResume = hasResumed.withLock { resumed -> Bool in
          guard !resumed else { return false }
          resumed = true
          return true
        }
        guard shouldResume else { return }
        connection.cancel()
        continuation.resume(returning: isOpen)
      }

      connection.stateUpdateHandler = { state in
        switch state {
        case .ready:
          finish(true)
        case .failed, .cancelled:
          finish(false)
        default:
          // `.waiting` is how an iPhone RTSP listener starts. Treating it as closed is why a
          // subnet scan found NearStream boxes and never TS Cameraman.
          break
        }
      }
      connection.start(queue: Self.probeQueue)
      Self.probeQueue.asyncAfter(deadline: .now() + timeout) { finish(false) }
    }
  }

  private static let probeQueue = DispatchQueue(
    label: "app.teamstation.director.rtsp.scan",
    attributes: .concurrent
  )

  /// /24s to sweep instead of the local one, set from Settings. Empty sweeps this device's own subnet.
  private static let overrideSubnets = OSAllocatedUnfairLock<[IPv4Subnet]>(initialState: [])

  /// Sweeps the /24s whose network addresses these are (`10.10.6.0`) instead of the local subnet, or
  /// the local subnet again when empty. Every scanner reads them at the start of each sweep.
  public static func setOverrideSubnets(networkAddresses: [String]) {
    let subnets = networkAddresses.compactMap { IPv4Subnet(address: $0, netmask: "255.255.255.0") }
    overrideSubnets.withLock { $0 = subnets }
  }

  /// What a sweep covers: the override subnets when any are set, otherwise the local subnet. The
  /// override replaces the local subnet rather than adding to it.
  public static func scanSubnets() -> [IPv4Subnet] {
    let override = overrideSubnets.withLock { $0 }
    if !override.isEmpty { return override }
    return localSubnet().map { [$0] } ?? []
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
