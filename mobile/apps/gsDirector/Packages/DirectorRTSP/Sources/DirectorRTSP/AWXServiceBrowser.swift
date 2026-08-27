import Foundation
import Network
import DirectorSources

/// Live snapshot of `_awx_service._tcp` instances. Identity only: the SRV port is closed.
public protocol CameraAdvertisementBrowsing: AnyObject, Sendable {
  var advertisements: [CameraAdvertisement] { get }
  /// Compact NWBrowser state for the HUD (`ready`, `waiting`, `failed`).
  var browseState: String { get }
  /// Last `_bonjour` result set size. Zero means the browser is up but has not seen an instance.
  var browseResultCount: Int { get }
  func start()
  func stop()
}

extension CameraAdvertisementBrowsing {
  public var browseState: String { "idle" }
  public var browseResultCount: Int { 0 }
}

/// Test double. Production uses `CompositeAdvertisementBrowser` of AWX and `_rtsp._tcp`.
public final class StaticAdvertisementBrowser: CameraAdvertisementBrowsing, @unchecked Sendable {
  public var advertisements: [CameraAdvertisement]

  public init(_ advertisements: [CameraAdvertisement] = []) {
    self.advertisements = advertisements
  }

  public func start() {}
  public func stop() {}
}

/// NearStream identity plus GS Cameraman `_rtsp._tcp`, so one discovery sweep sees both.
public final class CompositeAdvertisementBrowser: CameraAdvertisementBrowsing, @unchecked Sendable {
  private let browsers: [any CameraAdvertisementBrowsing]

  public init(_ browsers: [any CameraAdvertisementBrowsing]) {
    self.browsers = browsers
  }

  public var advertisements: [CameraAdvertisement] {
    browsers.flatMap(\.advertisements)
  }

  public var browseState: String {
    browsers.map(\.browseState).joined(separator: ",")
  }

  public var browseResultCount: Int {
    browsers.reduce(0) { $0 + $1.browseResultCount }
  }

  public func start() {
    for browser in browsers { browser.start() }
  }

  public func stop() {
    for browser in browsers { browser.stop() }
  }
}

/// Browses AuditoryWorks VM33 advertisements and resolves each instance to an IPv4 address.
public final class AWXServiceBrowser: CameraAdvertisementBrowsing, @unchecked Sendable {
  public static let serviceType = "_awx_service._tcp"

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
    // An empty update is a Bonjour glitch, not "every camera vanished". Wiping the cache here
    // would leave identity with nothing to match until UDP resolve finishes again.
    lock.lock()
    browseResultCountStorage = results.count
    lock.unlock()
    guard !results.isEmpty else { return }

    var seen: Set<String> = []
    for result in results {
      guard case .service(let name, _, _, _) = result.endpoint else { continue }
      seen.insert(name)
      resolve(result, instanceName: name)
    }

    lock.lock()
    for name in cached.keys where !seen.contains(name) {
      cached.removeValue(forKey: name)
      resolvers.removeValue(forKey: name)?.cancel()
    }
    lock.unlock()
  }

  private func resolve(_ result: NWBrowser.Result, instanceName: String) {
    let fields = txtFields(from: result)

    // TXT `ip=` is enough. Connecting UDP to SRV 25644 never becomes ready because that port is closed.
    if let host = CameraAdvertisement.resolvedHost(txtFields: fields) {
      lock.lock()
      cached[instanceName] = CameraAdvertisement.parseTXT(
        fields,
        instanceName: instanceName,
        host: host
      )
      lock.unlock()
      return
    }

    lock.lock()
    if resolvers[instanceName] != nil {
      if let host = cached[instanceName]?.host {
        cached[instanceName] = CameraAdvertisement.parseTXT(
          fields,
          instanceName: instanceName,
          host: host
        )
      }
      lock.unlock()
      return
    }

    let parameters = NWParameters.udp
    parameters.includePeerToPeer = true
    let connection = NWConnection(to: result.endpoint, using: parameters)
    resolvers[instanceName] = connection
    lock.unlock()

    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection else { return }
      switch state {
      case .ready:
        let host = CameraAdvertisement.resolvedHost(
          txtFields: fields,
          pathIPv4: Self.ipv4(from: connection.currentPath?.remoteEndpoint)
        )
        connection.cancel()
        self.lock.lock()
        self.resolvers[instanceName] = nil
        if let host {
          self.cached[instanceName] = CameraAdvertisement.parseTXT(
            fields,
            instanceName: instanceName,
            host: host
          )
        }
        self.lock.unlock()
      case .failed, .cancelled:
        self.lock.lock()
        self.resolvers[instanceName] = nil
        self.lock.unlock()
      default:
        break
      }
    }
    connection.start(queue: .global(qos: .utility))
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

  private static func ipv4(from endpoint: NWEndpoint?) -> String? {
    guard case .hostPort(let host, _) = endpoint else { return nil }
    switch host {
    case .ipv4(let address):
      return address.debugDescription.split(separator: "%").first.map(String.init)
    case .name(let name, _):
      return name
    default:
      return nil
    }
  }
}
