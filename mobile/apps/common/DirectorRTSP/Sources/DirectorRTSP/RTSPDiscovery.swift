import Foundation
import DirectorCore
import DirectorSources

/// Finds cameras and hands them to the app as `DiscoveredSource`s.
///
/// Discovery deliberately knows nothing about which camera is which. It reports the endpoints that
/// answered, and the identity layer — which owns the operator's names and the binding rules — says
/// what each one is called. That split is why a camera changing address is a rebinding question
/// rather than a discovery bug.
public final class RTSPDiscovery: SourceDiscovery, @unchecked Sendable {
  public struct Configuration: Sendable {
    public var port: Int
    public var path: String
    /// Hosts entered by the operator or passed by a launch argument. A first-class input, not a
    /// fallback: cameras on another subnet, or a venue that blocks scanning, have no other route.
    public var manualHosts: [String]
    public var isScanEnabled: Bool
    public var rescanInterval: TimeInterval
    public var transport: RTSPSession.Transport
    public var username: String?
    public var password: String?

    public init(
      port: Int = 554,
      path: String = "/live/mainstream",
      manualHosts: [String] = [],
      isScanEnabled: Bool = true,
      rescanInterval: TimeInterval = 15,
      transport: RTSPSession.Transport = .tcp,
      username: String? = nil,
      password: String? = nil
    ) {
      self.port = port
      self.path = path
      self.manualHosts = manualHosts
      self.isScanEnabled = isScanEnabled
      self.rescanInterval = rescanInterval
      self.transport = transport
      self.username = username
      self.password = password
    }
  }

  /// How an endpoint gets its identity. Supplied by the layer that owns the named-camera cache.
  public typealias IdentityResolver = @Sendable (
    [CameraEndpoint],
    [CameraAdvertisement]
  ) -> [CameraEndpoint: (id: SourceID, name: String)]

  /// Whether a host is a camera this app can use. Injectable so a test can drive a sweep without a
  /// network.
  public typealias HostConfirmation = @Sendable (CameraEndpoint) async -> Bool

  /// Asks the identity layer to move a camera that has stopped answering onto a socket that
  /// advertises the same unique id or CNAME.
  public typealias RelocationRequest = @Sendable (SourceID) -> Void

  public let kind = SourceKind.rtsp

  private let configuration: Configuration
  private let scanner: SubnetScanner
  /// The most recent shared sweep, when something above is sweeping for us. Its own scanner then
  /// goes unused: two transports each scanning the same /24 is the duplication the shared sweep
  /// exists to remove, and the ARP cost is per address rather than per port.
  private var sharedScan: SubnetScanner.Result?
  private var isSweptExternally = false
  private let confirmHost: HostConfirmation
  private let clock: DirectorClock
  private let resolveIdentity: IdentityResolver?
  private let requestRelocation: RelocationRequest?
  private let coordinator: PlayoutCoordinator?
  private let advertisementBrowser: CameraAdvertisementBrowsing

  private let lock = NSLock()
  private var sources: [DiscoveredSource] = []
  private var endpoints: [CameraEndpoint] = []
  private var handler: DiscoveryChangeHandler?
  private var running = false
  private var periodicSearch = true
  private var task: Task<Void, Never>?
  private var status = "idle"
  /// Sources handed out by `makeSource`, weakly, so an endpoint already being watched is not probed
  /// again. A camera that is streaming has proved it is a camera, and a second connection to one
  /// that is mid-session is both wasted work and a request it may refuse.
  private var handedOut: [CameraEndpoint: WeakSource] = [:]
  private var relocationRequests: [SourceID: Date] = [:]
  /// Fallback keys when no identity layer is wired. Address is never part of the key.
  private var sessionIDs: [CameraEndpoint: SourceID] = [:]

  public init(
    configuration: Configuration = Configuration(),
    clock: DirectorClock = SystemClock(),
    resolveIdentity: IdentityResolver? = nil,
    requestRelocation: RelocationRequest? = nil,
    coordinator: PlayoutCoordinator? = nil,
    advertisementBrowser: CameraAdvertisementBrowsing = StaticAdvertisementBrowser(),
    confirmHost: HostConfirmation? = nil
  ) {
    self.configuration = configuration
    self.clock = clock
    self.resolveIdentity = resolveIdentity
    self.requestRelocation = requestRelocation
    self.coordinator = coordinator
    self.advertisementBrowser = advertisementBrowser
    scanner = SubnetScanner(port: configuration.port)

    let probe = RTSPEndpointProbe()
    self.confirmHost = confirmHost ?? { endpoint in
      await probe.confirm(host: endpoint.host, port: endpoint.port, path: endpoint.path) != nil
    }
  }

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  public var currentSources: [DiscoveredSource] {
    lock.lock()
    defer { lock.unlock() }
    return sources
  }

  public var currentEndpoints: [CameraEndpoint] {
    lock.lock()
    defer { lock.unlock() }
    return endpoints
  }

  public var advertisements: [CameraAdvertisement] {
    advertisementBrowser.advertisements
  }

  public var diagnostic: String {
    lock.lock()
    defer { lock.unlock() }
    return status
  }

  public func start(onChange: @escaping DiscoveryChangeHandler) {
    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    running = true
    handler = onChange
    lock.unlock()

    advertisementBrowser.start()

    task = Task { [weak self] in
      guard let self else { return }
      while !Task.isCancelled, isRunning {
        if isPeriodicSearchEnabled { await sweep() }
        try? await Task.sleep(for: .seconds(configuration.rescanInterval))
      }
    }
  }

  public var isPeriodicSearchEnabled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return periodicSearch
  }

  public func setPeriodicSearch(_ enabled: Bool) {
    lock.lock()
    periodicSearch = enabled
    lock.unlock()
  }

  public func searchNow() {
    rescan()
  }

  public var sweepPorts: [Int] { configuration.isScanEnabled ? [configuration.port] : [] }

  public func setSweepIsShared(_ isShared: Bool) {
    lock.lock()
    isSweptExternally = isShared
    if !isShared { sharedScan = nil }
    lock.unlock()
  }

  /// Confirmation stays on this transport's own cadence rather than the sweep's. The sweep is
  /// cheap enough to run every three seconds; a DESCRIBE probe to every open host is not, and
  /// probing five times as often to find cameras no sooner is a poor trade. A host set that has
  /// actually changed does get confirmed at once, which is what makes a camera that came back at
  /// a new address appear without waiting out the interval.
  public func acceptSweep(_ result: SubnetScanner.Result) {
    let mine = result.hosts(onPort: configuration.port)
    lock.lock()
    let changed = mine != (sharedScan?.openHosts ?? [])
    sharedScan = SubnetScanner.Result(
      openHosts: mine,
      probedCount: result.probedCount,
      subnet: result.subnet,
      diagnostic: result.diagnostic,
      portsByHost: result.portsByHost
    )
    let wasRunning = running
    lock.unlock()
    guard changed, wasRunning else { return }
    rescan()
  }

  private func latestSharedScan() -> SubnetScanner.Result? {
    lock.lock()
    defer { lock.unlock() }
    return isSweptExternally ? sharedScan : nil
  }

  public func stop() {
    lock.lock()
    running = false
    handler = nil
    let task = self.task
    self.task = nil
    lock.unlock()

    advertisementBrowser.stop()
    task?.cancel()
  }

  /// One pass: scan, confirm, name, publish. Also the single-shot path used when a camera has to be
  /// found again after moving.
  public func rescan() {
    Task { [weak self] in await self?.sweep() }
  }

  /// One sweep, awaited. `rescan()` is the fire-and-forget form the app uses.
  public func sweepNow() async {
    await sweep()
  }

  private func sweep() async {
    let scan: SubnetScanner.Result?
    if let shared = latestSharedScan() {
      scan = shared
    } else if configuration.isScanEnabled {
      scan = await scanner.scan()
    } else {
      scan = nil
    }

    // Manual hosts and Bonjour-resolved cameras are merged in before confirmation so they go
    // through the same check as scanned ones — a mistyped address should not become a permanently
    // broken tile. GS Cameraman is found on `_rtsp._tcp` TXT (`ip=`, `port=`, `uuid`), not the
    // subnet scan: iOS does not answer unsolicited TCP to :554 the way a NearStream box does.
    let rawAds = advertisementBrowser.advertisements
    var seen = Set<CameraEndpoint>()
    var candidates: [CameraEndpoint] = []
    for host in (scan?.openHosts ?? []) + configuration.manualHosts {
      let endpoint = endpoint(for: host, advertisements: rawAds)
      if seen.insert(endpoint).inserted {
        candidates.append(endpoint)
      }
    }
    for advertisement in rawAds {
      let endpoint = advertisement.endpoint
      if seen.insert(endpoint).inserted {
        candidates.append(endpoint)
      }
    }

    var confirmed: [CameraEndpoint] = []
    var skipped = 0
    for endpoint in candidates {
      if isBeingWatched(endpoint) {
        skipped += 1
        confirmed.append(endpoint)
        continue
      }
      if await confirmHost(endpoint) {
        confirmed.append(endpoint)
        continue
      }
      // GS Cameraman often fails a 2–5s DESCRIBE probe from another iOS device even when Bonjour
      // published a LAN IPv4. Listing it from the advertisement is how the operator can enable it;
      // the session then has peer-to-peer TCP and does not abort on `.waiting`.
      if let advertisement = rawAds.first(where: { $0.host == endpoint.host }),
         advertisement.uuid != nil,
         advertisement.hasUsableMediaHost {
        confirmed.append(endpoint)
      }
    }

    let collapsed = CameraIdentityRules.deduplicate(endpoints: confirmed, advertisements: rawAds)
    confirmed = collapsed.endpoints
    let ads = collapsed.advertisements

    let identifiedHosts = Set(ads.compactMap { advertisement -> String? in
      advertisement.uniqueID == nil ? nil : advertisement.host
    })
    confirmed.sort {
      let leftKnown = identifiedHosts.contains($0.host)
      let rightKnown = identifiedHosts.contains($1.host)
      if leftKnown != rightKnown { return leftKnown && !rightKnown }
      return $0.host < $1.host
    }

    let identities = resolveIdentity?(confirmed, ads) ?? [:]
    let discovered = sessionKeyedSources(
      endpoints: confirmed,
      identities: identities,
      advertisements: ads
    )

    let awxCount = ads.filter { $0.modelName != nil || $0.wlanMAC != nil }.count
    let rtspAds = ads.filter { $0.uuid != nil }
    let rtspHosts = rtspAds.map(\.host).joined(separator: ",")
    let diagnostic = [
      "scan=\(scan?.subnet ?? "off")",
      "probed=\(scan?.probedCount ?? 0)",
      "open=\(scan?.openHosts.count ?? 0)",
      "confirmed=\(confirmed.count)",
      "streaming=\(skipped)",
      "manual=\(configuration.manualHosts.count)",
      "awx=\(awxCount)",
      "rtsp=\(rtspAds.count)",
      rtspHosts.isEmpty ? nil : "rtsphost=\(rtspHosts)",
      "awxbrowse=\(advertisementBrowser.browseState)",
      "browsecnt=\(advertisementBrowser.browseResultCount)",
      scan?.diagnostic
    ]
      .compactMap { $0 }
      .joined(separator: " ")

    publish(sources: discovered, endpoints: confirmed, diagnostic: diagnostic)
  }

  /// Prefer the port and path Bonjour advertised for this host, so a Cameraman that bound 8554 is
  /// probed there rather than on the NearStream default of 554.
  private func endpoint(for host: String, advertisements: [CameraAdvertisement]) -> CameraEndpoint {
    if let advertisement = advertisements.first(where: { $0.host == host }) {
      return advertisement.endpoint
    }
    if let colon = host.lastIndex(of: ":"),
      let port = Int(host[host.index(after: colon)...]),
      port > 0,
      !host.contains("/")
    {
      return CameraEndpoint(
        host: String(host[..<colon]),
        port: port,
        path: configuration.path
      )
    }
    return CameraEndpoint(host: host, port: configuration.port, path: configuration.path)
  }

  /// Separate from `sweep` because a lock may not be taken across a suspension point, and this is
  /// the one place the scan's results become visible to everyone else.
  private func publish(sources: [DiscoveredSource], endpoints: [CameraEndpoint], diagnostic: String) {
    lock.lock()
    self.sources = sources
    self.endpoints = endpoints
    status = diagnostic
    let handler = self.handler
    lock.unlock()

    handler?(sources)
  }

  /// Session keys live here so `sweep` does not take the lock across a suspension point.
  private func sessionKeyedSources(
    endpoints: [CameraEndpoint],
    identities: [CameraEndpoint: (id: SourceID, name: String)],
    advertisements: [CameraAdvertisement]
  ) -> [DiscoveredSource] {
    lock.lock()
    defer { lock.unlock() }
    var discovered: [DiscoveredSource] = []
    discovered.reserveCapacity(endpoints.count)
    for endpoint in endpoints {
      let identity = identities[endpoint]
      let advertised = advertisements.first { $0.host == endpoint.host }?.advertisedName
      let trimmedAdvertised = advertised.flatMap { value -> String? in
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
      }
      discovered.append(DiscoveredSource(
        id: identity?.id ?? CameraIdentityRules.sessionID(for: endpoint, in: &sessionIDs),
        kind: .rtsp,
        advertisedName: identity?.name ?? trimmedAdvertised ?? CameraIdentityRules.unnamedFallback,
        address: endpoint.url
      ))
    }
    return discovered
  }

  /// A camera that keeps failing at a known-good address has probably been given another one.
  /// Searching first, then moving the camera, then republishing is what lets its tile come back
  /// under the same identity — so the archive it was writing continues rather than restarting.
  private func relocate(_ sourceID: SourceID) {
    lock.lock()
    let last = relocationRequests[sourceID]
    let now = Date()
    guard last == nil || now.timeIntervalSince(last!) > Self.relocationInterval else {
      lock.unlock()
      return
    }
    relocationRequests[sourceID] = now
    lock.unlock()

    Task { [weak self] in
      guard let self else { return }
      await sweep()
      requestRelocation?(sourceID)
      await sweep()
    }
  }

  /// A failing camera asks to be relocated on every retry. Answering more often than this would
  /// mean a whole subnet search per retry, for a camera that may simply be switched off.
  private static let relocationInterval: TimeInterval = 20

  /// True while a source handed out for this endpoint is still watching it.
  private func isBeingWatched(_ endpoint: CameraEndpoint) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    // Dead entries are cleared here rather than on a timer: this is the only place that asks.
    for (key, box) in handedOut where box.source == nil {
      handedOut.removeValue(forKey: key)
    }
    return handedOut[endpoint]?.source?.isRunning == true
  }

  public func makeSource(for discovered: DiscoveredSource) throws -> FrameSource {
    guard let endpoint = CameraEndpoint(address: discovered.address, fallbackPath: configuration.path) else {
      throw FrameSourceError.unavailable("no stream address for \(discovered.advertisedName)")
    }

    let source = RTSPFrameSource(
      sourceID: discovered.id,
      displayName: discovered.advertisedName,
      configuration: RTSPSession.Configuration(
        host: endpoint.host,
        port: endpoint.port,
        path: endpoint.path,
        username: configuration.username,
        password: configuration.password,
        transport: configuration.transport
      ),
      clock: clock,
      coordinator: coordinator,
      onNeedsRelocation: { [weak self] sourceID in
        self?.relocate(sourceID)
      }
    )

    lock.lock()
    handedOut[endpoint] = WeakSource(source: source)
    lock.unlock()

    return source
  }

  private struct WeakSource {
    weak var source: RTSPFrameSource?
  }
}
