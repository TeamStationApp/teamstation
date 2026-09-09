import Foundation
import DirectorCore
import DirectorSources

/// Publishes the NDI sources on the network as `DiscoveredSource`s.
///
/// Unlike RTSP, there is no subnet to sweep and no port to probe: NDI cameras announce themselves
/// over mDNS and the SDK's finder maintains the list. So this is a thin adapter over `NDIFinder`
/// with one background thread parked in `waitForChange` — which costs nothing between sightings and
/// reacts the instant a camera appears or goes.
///
/// `setPeriodicSearch(false)` costs nothing here and stops nothing: the finder is fed by the SDK's
/// own mDNS listener, which runs regardless, and every change it reports is republished for as long
/// as anyone is listening — which, in the app, is always. There is no scan to switch off and so no
/// radio to spare; the flag only shows in the diagnostic. A camera that comes back is picked up as
/// soon as the finder hears it, with or without `searchNow`.
public final class NDIDiscovery: SourceDiscovery, @unchecked Sendable {
  public struct Configuration: Sendable {
    /// Whether senders on this machine are listed. True on a simulator, where the whole test rig
    /// is a generator on the same host; a real iPad has no local senders and the setting is moot.
    public var showLocalSources: Bool
    /// Addresses queried directly, for a camera the mDNS traffic cannot reach.
    public var extraIPs: [String]
    /// Names to restrict the list to, for a flow that must see a known set. Empty means everything.
    public var allowedNames: [String]

    public init(
      showLocalSources: Bool = true,
      extraIPs: [String] = [],
      allowedNames: [String] = []
    ) {
      self.showLocalSources = showLocalSources
      self.extraIPs = extraIPs
      self.allowedNames = allowedNames
    }
  }

  public let kind = SourceKind.ndi

  private var configuration: Configuration
  /// The fallback that finds a camera mDNS cannot resolve. Owned here because the addresses it
  /// finds go straight into this finder's `extra_ips`.
  private var sweeper: CameraSweeper?
  /// Set when something above is sweeping for us, so this one does not make the same broadcasts
  /// a second time.
  private var isSweptExternally = false
  private let clock: DirectorClock
  /// Where an on-demand search runs. Never the caller's thread: `searchNow` reaches the finder,
  /// the finder's lock is also held by the discovery thread's wait, and the one caller that
  /// matters is the main thread opening the camera list. Answering it synchronously froze the app
  /// for as long as that wait had left to run — five seconds, when a camera had stopped being
  /// discoverable and the wait never returned early. Results reach the UI through the change
  /// handler either way, so nothing needs the answer in hand.
  private let searchQueue = DispatchQueue(label: "co.gamestation.director.ndi.search")
  private let makeSourceFor: @Sendable (DiscoveredSource, NDISource) throws -> FrameSource

  private let lock = NSLock()
  private var finder: NDIFinder?
  private var sources: [DiscoveredSource] = []
  private var byID: [SourceID: NDISource] = [:]
  private var handler: DiscoveryChangeHandler?
  private var running = false
  private var periodicSearch = true
  private var thread: Thread?
  private var status = "idle"
  /// Highest number of sources seen this session. A camera that has gone is worth showing as gone
  /// rather than as never-having-existed, which is the difference between "unplug it and check"
  /// and "was it ever configured?".
  private var everSeen = 0

  public init(
    configuration: Configuration = Configuration(),
    clock: DirectorClock = SystemClock(),
    makeSource: @escaping @Sendable (DiscoveredSource, NDISource) throws -> FrameSource
  ) {
    self.configuration = configuration
    self.clock = clock
    self.makeSourceFor = makeSource
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

  /// Shaped like `RTSPDiscovery`'s so the HUD and `/dump-state` parse one format.
  public var diagnostic: String {
    lock.lock()
    let status = self.status
    let sweeper = self.sweeper
    lock.unlock()
    guard let sweeper else { return status }
    return "\(status) \(sweeper.diagnostic)"
  }

  public func start(onChange: @escaping DiscoveryChangeHandler) {
    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    guard let finder = NDIFinder(
      showLocalSources: configuration.showLocalSources,
      extraIPs: configuration.extraIPs
    ) else {
      status = "ndi=off reason=\(NDIRuntime.shared.unavailableReason ?? "finder unavailable")"
      running = false
      lock.unlock()
      onChange([])
      return
    }
    self.finder = finder
    self.handler = onChange
    running = true
    status = "ndi=on found=0 seen=0"
    lock.unlock()

    startSweeper()

    // A thread rather than a Task: the body parks in a blocking SDK call for seconds at a time,
    // and a suspended cooperative thread pool is how a whole app stops scheduling.
    let thread = Thread { [weak self] in self?.watch() }
    thread.name = "co.gamestation.director.ndi.find"
    thread.qualityOfService = .utility
    lock.lock()
    self.thread = thread
    lock.unlock()
    thread.start()

    // Publish whatever mDNS already knows before the first wait returns, so a camera that was
    // already on the network appears immediately rather than after a timeout.
    republish()
  }

  public func stop() {
    lock.lock()
    sweeper?.stop()
    sweeper = nil
    running = false
    handler = nil
    finder = nil
    thread = nil
    sources = []
    byID = [:]
    status = "idle"
    lock.unlock()
  }

  public func setPeriodicSearch(_ enabled: Bool) {
    lock.lock()
    periodicSearch = enabled
    lock.unlock()
  }

  /// Replace the addresses the finder queries directly.
  ///
  /// `p_extra_ips` is fixed when a finder is created, so this destroys the current one and builds
  /// another. That is why it only acts on a genuine change: recreating the finder restarts
  /// discovery, and doing it on every sweep would empty the source list a few times a minute.
  ///
  /// Worth the cost when it does change, because it is the only route to a camera that mDNS cannot
  /// resolve. Measured on a Hollyland Cosmo C2 back from a reboot: browsable service names with no
  /// SRV or A record behind them, invisible to every NDI receiver on the network, and found by
  /// name the moment its address was handed over this way.
  public func setSweepDemand(isBusy: Bool, anyEnabledCameraMissing: Bool) {
    lock.lock()
    let sweeper = self.sweeper
    lock.unlock()
    sweeper?.setDemand(isBusy: isBusy, anyEnabledCameraMissing: anyEnabledCameraMissing)
  }

  /// Diagnostic for the fallback sweep, appended to this discovery's own status.
  public var sweepDiagnostic: String {
    lock.lock()
    let sweeper = self.sweeper
    lock.unlock()
    return sweeper?.diagnostic ?? "sweep=off"
  }

  /// The port an NDI machine answers "what sources are you running?" on.
  ///
  /// 5960, not the 5961 a stream connection uses: the docs describe 5960 as the TCP port "used for
  /// remote sources to query this machine and discover all the sources running on it… from an IP
  /// address alone". A camera with no stream connected has 5961 closed and 5960 open, so sweeping
  /// 5961 would find only cameras that happen to be in use.
  public static let queryPort = 5_960

  public var sweepPorts: [Int] { [Self.queryPort] }

  public func setSweepIsShared(_ isShared: Bool) {
    lock.lock()
    isSweptExternally = isShared
    let existing = isShared ? sweeper : nil
    if isShared { sweeper = nil }
    lock.unlock()
    existing?.stop()
  }

  /// The finder's `p_extra_ips`, from whatever swept. Only the addresses that answered on the
  /// query port: handing it every host on the segment would have it querying printers.
  public func acceptSweep(_ result: SubnetScanner.Result) {
    setExtraIPs(result.hosts(onPort: Self.queryPort))
  }

  /// Its own sweep, for when nothing else is driving one — a single-transport rig, or a test that
  /// builds this discovery on its own. Under `CompositeSourceDiscovery` the shared sweep calls
  /// `acceptSweep` instead and this stays unused, so the segment sees one pass rather than two.
  private func startSweeper() {
    guard sweeper == nil, !isSweptExternally else { return }
    let sweeper = CameraSweeper(ports: [Self.queryPort]) { [weak self] result in
      self?.acceptSweep(result)
    }
    self.sweeper = sweeper
    sweeper.start()
  }

  public func setExtraIPs(_ addresses: [String]) {
    let wanted = Set(addresses)
    lock.lock()
    guard running else {
      configuration.extraIPs = addresses
      lock.unlock()
      return
    }
    guard Set(configuration.extraIPs) != wanted else {
      lock.unlock()
      return
    }
    configuration.extraIPs = addresses
    let replacement = NDIFinder(
      showLocalSources: configuration.showLocalSources,
      extraIPs: addresses
    )
    guard let replacement else {
      lock.unlock()
      return
    }
    // The discovery thread may be parked in the old finder's wait. It holds its own strong
    // reference for the duration of that call, so the old instance outlives this swap and is
    // released when that call returns.
    finder = replacement
    lock.unlock()
    searchNow()
  }

  public func searchNow() {
    searchQueue.async { [weak self] in
      self?.republish()
    }
  }

  public func makeSource(for discovered: DiscoveredSource) throws -> FrameSource {
    lock.lock()
    let ndiSource = byID[discovered.id]
    lock.unlock()

    guard let ndiSource else {
      // The name is the only thing `NDIlib_recv_connect` needs, and `DiscoveredSource.address`
      // carries it, so a source the finder has since dropped can still be connected to. The SDK
      // reconnects on its own when it comes back.
      guard let address = discovered.address, !address.isEmpty else {
        throw FrameSourceError.unavailable("NDI source \(discovered.id.rawValue) is not on the network")
      }
      return try makeSourceFor(discovered, NDISource(name: NDISourceName(full: address), url: ""))
    }
    return try makeSourceFor(discovered, ndiSource)
  }

  // MARK: - Discovery loop

  private func watch() {
    while true {
      lock.lock()
      let finder = self.finder
      let running = self.running
      lock.unlock()
      guard running, let finder else { return }

      // Five seconds is the SDK example's own figure, and it is a ceiling rather than a poll
      // interval: the call returns the moment anything changes.
      _ = finder.waitForChange(timeoutMilliseconds: 5_000)
      republish()
    }
  }

  private func republish() {
    lock.lock()
    guard running, let finder, periodicSearch || handler != nil else {
      lock.unlock()
      return
    }
    lock.unlock()

    let found = finder.currentSources
    let allowed = configuration.allowedNames
    let visible = allowed.isEmpty
      ? found
      : found.filter { source in
        allowed.contains { source.name.full == $0 || source.name.stream == $0 }
      }

    var discovered: [DiscoveredSource] = []
    var index: [SourceID: NDISource] = [:]
    for source in visible {
      let id = source.name.sourceID
      // Two senders may share a full name if one is on a machine the other cannot see. The first
      // wins and the second is dropped rather than silently replacing it mid-game.
      guard index[id] == nil else { continue }
      index[id] = source
      discovered.append(DiscoveredSource(
        id: id,
        kind: .ndi,
        advertisedName: source.name.displayName,
        address: source.name.full
      ))
    }

    lock.lock()
    guard running else {
      lock.unlock()
      return
    }
    everSeen = max(everSeen, discovered.count)
    let unchanged = discovered == sources
    sources = discovered
    byID = index
    status = "ndi=on found=\(discovered.count) seen=\(everSeen)"
      + (configuration.extraIPs.isEmpty ? "" : " extra=\(configuration.extraIPs.count)")
      + (periodicSearch ? "" : " periodic=off")
    let handler = self.handler
    lock.unlock()

    guard !unchanged else { return }
    handler?(discovered)
  }
}
