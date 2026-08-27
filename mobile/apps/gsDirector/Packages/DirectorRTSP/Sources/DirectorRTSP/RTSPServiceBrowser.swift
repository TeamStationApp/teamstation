import Foundation
import Network
import Darwin
import DirectorSources

/// Live snapshot of `_rtsp._tcp` instances — GS Cameraman, and any other phone that advertises RTSP.
///
/// The SRV port is the media port (554, or 8554 when 554 is taken). Identity is TXT `uuid`.
/// Resolving uses a TCP connection to the Bonjour endpoint rather than a raw IP: iOS will not
/// accept unsolicited LAN TCP the way a NearStream box does, which is why a subnet scan finds the
/// VM33s and misses the iPhone.
public final class RTSPServiceBrowser: CameraAdvertisementBrowsing, @unchecked Sendable {
  public static let serviceType = "_rtsp._tcp"

  private let lock = NSLock()
  private var cached: [String: CameraAdvertisement] = [:]
  private var browser: NWBrowser?
  private var resolvers: [String: NWConnection] = [:]
  private var browseStateStorage = "idle"
  private var browseResultCountStorage = 0

  public init() {}

  public var advertisements: [CameraAdvertisement] {
    lock.lock()
    defer { lock.unlock() }
    return Array(cached.values)
  }

  public var browseState: String {
    lock.lock()
    defer { lock.unlock() }
    return browseStateStorage
  }

  public var browseResultCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return browseResultCountStorage
  }

  public func start() {
    lock.lock()
    guard browser == nil else {
      lock.unlock()
      return
    }
    let parameters = NWParameters()
    parameters.includePeerToPeer = true
    let next = NWBrowser(
      for: .bonjourWithTXTRecord(type: Self.serviceType, domain: "local."),
      using: parameters
    )
    browser = next
    browseStateStorage = "setup"
    lock.unlock()

    next.stateUpdateHandler = { [weak self] state in
      self?.lock.lock()
      self?.browseStateStorage = Self.describe(state)
      self?.lock.unlock()
    }
    next.browseResultsChangedHandler = { [weak self] results, _ in
      self?.apply(results)
    }
    next.start(queue: .global(qos: .utility))
  }

  public func stop() {
    lock.lock()
    browser?.cancel()
    browser = nil
    let connections = Array(resolvers.values)
    resolvers.removeAll()
    cached.removeAll()
    lock.unlock()
    connections.forEach { $0.cancel() }
  }

  private func apply(_ results: Set<NWBrowser.Result>) {
    lock.lock()
    browseResultCountStorage = results.count
    lock.unlock()
    guard !results.isEmpty else { return }

    var seen: Set<String> = []
    for result in results {
      guard case .service(let name, _, _, _) = result.endpoint else { continue }
      let fields = txtFields(from: result)
      let key = Self.cacheKey(instanceName: name, fields: fields)
      seen.insert(key)

      // TXT `ip=` is enough — same path NearStream uses. Connecting TCP to a Cameraman
      // Bonjour UUID hostname often never yields a LAN IPv4 from another iOS device.
      if let host = CameraAdvertisement.resolvedHost(txtFields: fields) {
        lock.lock()
        cached[key] = CameraAdvertisement.parseTXT(
          fields,
          instanceName: name,
          host: host
        )
        lock.unlock()
        continue
      }

      lock.lock()
      if let existing = cached[key] {
        cached[key] = CameraAdvertisement.parseTXT(
          fields,
          instanceName: name,
          host: existing.host,
          port: Int(existing.port)
        )
        if CameraAdvertisement.isUsableMediaHost(existing.host) {
          lock.unlock()
          continue
        }
      }
      lock.unlock()
      resolve(result, instanceName: name, cacheKey: key, fields: fields)
    }

    lock.lock()
    for name in cached.keys where !seen.contains(name) {
      cached.removeValue(forKey: name)
      resolvers.removeValue(forKey: name)?.cancel()
    }
    lock.unlock()
  }

  private func resolve(
    _ result: NWBrowser.Result,
    instanceName: String,
    cacheKey: String,
    fields: [String: String]
  ) {
    lock.lock()
    if resolvers[cacheKey] != nil {
      lock.unlock()
      return
    }

    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = true
    if let ipOptions = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ipOptions.version = .v4
    }
    let connection = NWConnection(to: result.endpoint, using: parameters)
    resolvers[cacheKey] = connection
    lock.unlock()

    let finish: @Sendable (NWConnection, Bool) -> Void = { [weak self] connection, force in
      guard let self else { return }
      let media = Self.usableMediaHost(from: connection.currentPath?.remoteEndpoint)
      let txtHost = CameraAdvertisement.resolvedHost(txtFields: fields)
      if media == nil, txtHost == nil, !force { return }
      connection.cancel()
      self.lock.lock()
      self.resolvers[cacheKey] = nil
      if let host = media?.host ?? txtHost {
        self.cached[cacheKey] = CameraAdvertisement.parseTXT(
          fields,
          instanceName: instanceName,
          host: host,
          port: media.map { Int($0.port) } ?? 554
        )
      }
      self.lock.unlock()
    }

    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection else { return }
      switch state {
      case .ready:
        finish(connection, false)
      case .failed, .cancelled:
        connection.cancel()
        self.lock.lock()
        if self.resolvers[cacheKey] === connection {
          self.resolvers[cacheKey] = nil
        }
        self.lock.unlock()
      default:
        break
      }
    }
    connection.start(queue: .global(qos: .utility))
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 6) { [weak connection] in
      guard let connection else { return }
      finish(connection, true)
    }
  }

  private static func cacheKey(instanceName: String, fields: [String: String]) -> String {
    let lookup = Dictionary(uniqueKeysWithValues: fields.map { ($0.key.lowercased(), $0.value) })
    if let uuid = lookup["uuid"]?.trimmingCharacters(in: .whitespacesAndNewlines), !uuid.isEmpty {
      return "uuid:\(uuid.lowercased())"
    }
    return "name:\(instanceName)"
  }

  private static func describe(_ state: NWBrowser.State) -> String {
    switch state {
    case .setup: return "setup"
    case .ready: return "ready"
    case .cancelled: return "cancelled"
    case .waiting: return "waiting"
    case .failed: return "failed"
    @unknown default: return "other"
    }
  }

  private func txtFields(from result: NWBrowser.Result) -> [String: String] {
    guard case .bonjour(let record) = result.metadata else { return [:] }
    var fields: [String: String] = [:]
    for (key, value) in record.dictionary where !value.isEmpty {
      fields[key] = value
    }
    return fields
  }

  private static func usableMediaHost(from endpoint: NWEndpoint?) -> (host: String, port: UInt16)? {
    let resolved = hostPort(from: endpoint)
    if let resolved, CameraAdvertisement.isUsableMediaHost(resolved.host) {
      return resolved
    }
    if let host = resolved?.host, CameraAdvertisement.isUUIDHostname(host),
       let lan = lanIPv4(for: host) {
      return (lan, resolved?.port ?? 554)
    }
    return nil
  }

  /// mDNS A records for a Bonjour target. Picks the LAN address and ignores USB link-local.
  private static func lanIPv4(for hostname: String) -> String? {
    var hints = addrinfo(
      ai_flags: 0,
      ai_family: AF_INET,
      ai_socktype: SOCK_STREAM,
      ai_protocol: IPPROTO_TCP,
      ai_addrlen: 0,
      ai_canonname: nil,
      ai_addr: nil,
      ai_next: nil
    )
    var info: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(hostname, nil, &hints, &info) == 0, let first = info else { return nil }
    defer { freeaddrinfo(first) }

    var hosts: [String] = []
    var cursor: UnsafeMutablePointer<addrinfo>? = first
    while let current = cursor {
      if current.pointee.ai_family == AF_INET, let addr = current.pointee.ai_addr {
        var ipv4 = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &ipv4.sin_addr, &buffer, socklen_t(INET_ADDRSTRLEN))
        hosts.append(String(cString: buffer))
      }
      cursor = current.pointee.ai_next
    }
    return CameraAdvertisement.preferredMediaHost(among: hosts)
  }

  private static func hostPort(from endpoint: NWEndpoint?) -> (host: String, port: UInt16)? {
    guard case .hostPort(let host, let port) = endpoint else { return nil }
    switch host {
    case .ipv4(let address):
      guard let text = address.debugDescription.split(separator: "%").first.map(String.init) else {
        return nil
      }
      return (text, port.rawValue)
    case .name(let name, _):
      return (name, port.rawValue)
    case .ipv6(let address):
      guard let text = address.debugDescription.split(separator: "%").first.map(String.init) else {
        return nil
      }
      return ("[\(text)]", port.rawValue)
    default:
      return nil
    }
  }
}
