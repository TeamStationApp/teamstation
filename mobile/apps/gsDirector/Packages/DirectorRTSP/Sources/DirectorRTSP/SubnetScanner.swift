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
  }

  private let port: Int
  private let timeout: TimeInterval
  private let concurrency: Int

  public init(port: Int = 554, timeout: TimeInterval = 0.3, concurrency: Int = 32) {
    self.port = port
    self.timeout = timeout
    self.concurrency = concurrency
  }

  public func scan() async -> Result {
    guard let subnet = Self.localSubnet() else {
      return Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: "no IPv4 interface")
    }
    guard let hosts = subnet.hostAddresses() else {
      return Result(
        openHosts: [],
        probedCount: 0,
        subnet: subnet.cidrDescription,
        diagnostic: "refusing to scan \(subnet.cidrDescription): wider than /\(IPv4Subnet.widestAllowedPrefix)"
      )
    }

    let open = await probe(hosts: hosts)
    return Result(
      openHosts: open.sorted { (IPv4Subnet.parse($0) ?? 0) < (IPv4Subnet.parse($1) ?? 0) },
      probedCount: hosts.count,
      subnet: subnet.cidrDescription,
      diagnostic: nil
    )
  }

  /// Probes in bounded batches. Opening a thousand sockets at once exhausts the process's file
  /// descriptors, and the failures look exactly like closed ports.
  private func probe(hosts: [String]) async -> [String] {
    var open: [String] = []
    var index = 0

    while index < hosts.count {
      let batch = hosts[index ..< min(index + concurrency, hosts.count)]
      index += batch.count

      let found = await withTaskGroup(of: String?.self) { group in
        for host in batch {
          group.addTask { [self] in await isOpen(host: host) ? host : nil }
        }
        var results: [String] = []
        for await result in group {
          if let result { results.append(result) }
        }
        return results
      }
      open.append(contentsOf: found)
    }
    return open
  }

  private func isOpen(host: String) async -> Bool {
    guard let port = NWEndpoint.Port(rawValue: UInt16(self.port)) else { return false }

    return await withCheckedContinuation { continuation in
      let parameters = NWParameters.tcp
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
        case .waiting:
          // On a LAN this is a closed port or an absent host, not a slow one.
          finish(false)
        default:
          break
        }
      }
      connection.start(queue: Self.probeQueue)
      Self.probeQueue.asyncAfter(deadline: .now() + timeout) { finish(false) }
    }
  }

  private static let probeQueue = DispatchQueue(
    label: "co.gamestation.director.rtsp.scan",
    attributes: .concurrent
  )

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
