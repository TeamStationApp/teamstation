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
}
