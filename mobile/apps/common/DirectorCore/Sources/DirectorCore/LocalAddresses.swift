import Foundation

/// The IPv4 addresses this device is reachable on.
///
/// Needed because the other end of every camera link is this device, and nothing else can say
/// which address that is. A camera's own address is already discoverable — it advertises one and
/// the app records what it bound to — but the Director's was only knowable by asking the network
/// rather than the app, and on a bench where a device holds a lease per SSID that is a guess.
///
/// Conditioning a link needs both ends named: shaping the camera does nothing if the Director is
/// somewhere the shaper cannot see, and finding that out took a stack of Wi-Fi counters that
/// should not have been necessary.
public enum LocalAddresses {
  /// Every non-loopback IPv4 address, with the interface that carries it, as `en0=10.0.0.5`.
  ///
  /// Interface names are kept because a device on two networks has two answers and which one
  /// matters depends on what is being asked. Wi-Fi is `en0` on iOS.
  public static func ipv4() -> [String] {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return [] }
    defer { freeifaddrs(head) }

    var found: [String] = []
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let flags = Int32(pointer.pointee.ifa_flags)
      guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0 else { continue }
      guard let address = pointer.pointee.ifa_addr,
            address.pointee.sa_family == UInt8(AF_INET)
      else { continue }

      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let result = getnameinfo(
        address,
        socklen_t(address.pointee.sa_len),
        &host,
        socklen_t(host.count),
        nil,
        0,
        NI_NUMERICHOST
      )
      guard result == 0 else { continue }
      let name = String(cString: pointer.pointee.ifa_name)
      let text = String(cString: host)
      guard !text.isEmpty else { continue }
      found.append("\(name)=\(text)")
    }
    return found.sorted()
  }

  /// Bytes received on Wi-Fi since boot, as the interface's own 32-bit counter.
  ///
  /// The one place the NDI camera's wire rate can be read at all: the SDK owns that socket, so the
  /// interface total less what the RTSP cameras account for is what the NDI camera is sending.
  /// Nil when there is no `en0`.
  public static func wifiReceivedBytes() -> UInt32? {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return nil }
    defer { freeifaddrs(head) }
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      guard String(cString: pointer.pointee.ifa_name) == "en0",
            let address = pointer.pointee.ifa_addr,
            address.pointee.sa_family == UInt8(AF_LINK),
            let data = pointer.pointee.ifa_data
      else { continue }
      return data.assumingMemoryBound(to: if_data.self).pointee.ifi_ibytes
    }
    return nil
  }
}

/// Extends a 32-bit interface counter into one that does not wrap.
///
/// `if_data` counts bytes in 32 bits, which a 50 Mbps camera wraps in under twelve minutes. Read
/// at least once per wrap — the telemetry tick is once a second — the wrapping difference between
/// two reads is exactly what arrived between them.
public struct WrappingByteCounter: Sendable, Equatable {
  private var last: UInt32?
  public private(set) var total: UInt64 = 0

  public init() {}

  public mutating func extend(_ raw: UInt32) -> UInt64 {
    if let last { total &+= UInt64(raw &- last) }
    last = raw
    return total
  }
}
