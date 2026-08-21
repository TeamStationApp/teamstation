import AVFoundation
import Foundation
import Observation
import DirectorCore
import DirectorDVR
import DirectorPipeline
import DirectorSources
import DirectorTestHarness
import UIKit

/// One-shot latch, so the replay latency is recorded for the first decoded frame and not
/// overwritten by every frame after it.
private final class FirstFrameStamp: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if claimed { return false }
    claimed = true
    return true
  }
}

/// Buys wall-clock time from iOS to finish work that a backgrounded app would otherwise be
/// suspended in the middle of.
///
/// Holds the identifier in a reference type so the expiration handler can clear it. Capturing a
/// mutable local in that escaping closure is not allowed under strict concurrency, and letting the
/// assertion expire without ending it gets the app killed rather than suspended.
private final class BackgroundAssertion: @unchecked Sendable {
  private let lock = NSLock()
  private var identifier: UIBackgroundTaskIdentifier = .invalid

  init(name: String) {
    identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
      self?.end()
    }
  }

  func end() {
    lock.lock()
    let current = identifier
    identifier = .invalid
    lock.unlock()
    guard current != .invalid else { return }
    UIApplication.shared.endBackgroundTask(current)
  }

  deinit { end() }
}

/// Composition root and the only object the views talk to.
///
/// Everything expensive lives below it in non-isolated classes with their own queues; this
/// type is `@MainActor` and holds only what SwiftUI needs to draw. Telemetry is **polled** at
/// 5 Hz rather than pushed per frame — a 30 fps, four-source push would be 120 main-actor hops
/// a second to update a debug label (I6).
@MainActor
@Observable
public final class AppEnvironment {
  public enum Screen: String, Sendable {
    case directing
  }

  public enum Sheet: String, Identifiable, Sendable {
    case settings, perfHarness, cameras, recordings

    public var id: String { rawValue }
  }

  // MARK: - Observable state

  public private(set) var launch: LaunchConfiguration
  /// What is actually running this session, including launch-argument overlays.
  public private(set) var config: AppConfig
  /// What Settings edits and what survives a relaunch. Launch arguments never write here, which is
  /// how a Maestro scoreboard URL stays a test fixture instead of replacing the operator's.
  public private(set) var persistedConfig: AppConfig
  public private(set) var selections: [SourceSelection] = []
  /// Every camera the operator has ever named. Survives relaunches so a name typed at the first
  /// game is still offered at the next one, whatever address the camera turns up on.
  public private(set) var cameraRecords: [CameraRecord] = []
  /// The address each live tile's session was built against, so a camera that moves can be spotted
  /// by comparing it with what discovery reports now.
  private var pipelineEndpoints: [SourceID: CameraEndpoint] = [:]
  /// Where each row's camera is answering. Held here rather than read back out of discovery, because
  /// naming a camera changes its `SourceID` immediately while discovery's own list is one sweep
  /// behind — and a row that cannot find its endpoint stops being a camera as far as the UI is
  /// concerned.
  private var rowEndpoints: [SourceID: CameraEndpoint] = [:]
  public private(set) var snapshot = TelemetrySnapshot()
  public private(set) var isRecording = false
  public private(set) var statusMessage: String?

  public func dismissStatusMessage() {
    statusMessage = nil
  }

  public private(set) var lastExport: ExportService.Result?
  public private(set) var lastRecordingShare: [URL] = []
  public var isSharingRecordings = false
  public private(set) var programOutput: URL?
  public private(set) var probeResult: EncodeSessionProbe.Result?
  public private(set) var discoveryUnavailableReason: String?
  public var screen: Screen = .directing
  /// One property for all four modals. Stacking `.sheet` modifiers on a single view silently
  /// leaves all but the last one unable to present, which made the settings and perf harness
  /// unreachable from the grid.
  public var activeSheet: Sheet?
  /// Which discovery this session is running. Settings can change it without a relaunch.
  private var sourceProfile: SourceProfile

  // MARK: - Machinery

  public let clock: DirectorClock
  public let telemetry: PipelineTelemetry
  public let router: TileRouter
  public let scorebug: ScorebugController

  let converter: PixelConverter
  let index: ArchiveIndex
  let proxyReader: ProxyReader
  let assembler: SegmentAssembler
  let exporter: ExportService
  let retention: RetentionPolicy
  let programEncoder: ProgramEncoder

  private let compositor: MetalCompositor?
  /// Builds the live-camera discovery. Injected because the transport lives in its own module and
  /// this one is written against `SourceDiscovery` alone.
  private let discoveryFactory: (@Sendable () -> SourceDiscovery?)?
  private let selectionStore: SourceSelectionStore
  /// The named-camera cache, shared with discovery so both agree on which camera is which.
  public let cameras: CameraRegistry
  private let configStore: ConfigStore
  private let stateDumper = StateDumper()
  private var controlServer: ControlServer?

  private var discovery: SourceDiscovery?
  private var writers: [SourceID: SegmentWriter] = [:]
  private var proxies: [SourceID: ProxyStore] = [:]
  private var recordingID: Int64?
  private var pollTimer: Timer?
  /// Width of one small source tile, used so Output scrub (if added) shares the 60s-per-width rate.
  public var smallTileWidth: Double = 300
  private var latestScorebugImage: CGImage?
  private var latestScorebugSize: CGSize = .zero
  private var retentionTimer: Timer?
  private var testClock: TestClock?
  private var scorebugLoaded = false
  private var announcedCameraStatus: [SourceID: String] = [:]

  // MARK: - Lifecycle

  public init(
    launch: LaunchConfiguration = .resolve(),
    cameras: CameraRegistry? = nil,
    discoveryFactory: (@Sendable () -> SourceDiscovery?)? = nil
  ) {
    self.launch = launch
    self.discoveryFactory = discoveryFactory

    let testClock = launch.useTestClock ? TestClock() : nil
    self.testClock = testClock
    self.clock = testClock ?? SystemClock()

    self.configStore = ConfigStore()
    let persisted = configStore.load()
    self.persistedConfig = persisted
    let session = Self.applying(launch, to: persisted)
    self.config = session
    self.sourceProfile = Self.resolveSourceProfile(launch: launch, config: session)

    self.selectionStore = SourceSelectionStore(store: configStore)
    // The app target passes the same registry it gave to discovery; anything without a transport
    // gets its own, which is empty and harmless.
    let registry = cameras ?? CameraRegistry(store: CameraRecordStore(store: configStore))
    registry.playout.setCap(
      milliseconds: session.displayLatencyCapEnabled
        ? session.displayLatencyCapMilliseconds
        : nil
    )
    self.cameras = registry
    self.telemetry = PipelineTelemetry(clock: clock)
    self.converter = PixelConverter()
    self.compositor = MetalCompositor(
      width: session.programResolution.width,
      height: session.programResolution.height
    )
    self.programEncoder = ProgramEncoder(telemetry: telemetry, converter: converter, config: session)
    self.router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: compositor,
      programEncoder: programEncoder,
      clock: clock
    )
    self.scorebug = ScorebugController(
      size: CGSize(width: session.programResolution.width, height: session.programResolution.height)
    )

    do {
      try DirectorPaths.createAll()
      let index = try ArchiveIndex()
      self.index = index
    } catch {
      // An unopenable index means no DVR at all, so fail loudly rather than limping: an
      // in-memory index would silently discard the operator's recording.
      fatalError("could not open the DVR index: \(error)")
    }
    self.proxyReader = ProxyReader(index: index)
    self.assembler = SegmentAssembler(index: index)
    self.exporter = ExportService(index: index)
    self.retention = RetentionPolicy(index: index, clock: clock)

    telemetry.mutate { [sourceProfile] snapshot in
      snapshot.sourceProfile = sourceProfile.rawValue
    }
  }

  /// Called once from the app's `task` modifier.
  public func bootstrap() async {
    if launch.isUITest { UIApplication.shared.isIdleTimerDisabled = true }
    if launch.clearState {
      selectionStore.clear()
      cameras.clear()
      telemetry.reset()
    }
    selections = selectionStore.load()
    cameraRecords = cameras.records

    // A mid-segment kill leaves index rows describing files that were never written. Cleaning
    // up before anything reads the timeline is what makes "relaunch after a crash" safe.
    if let result = try? index.reconcile(), result.removed > 0 {
      statusMessage = "Recovered index: dropped \(result.removed) missing segment(s)"
    }

    scorebug.onSnapshot = { [weak self] image, size in
      self?.latestScorebugImage = image
      self?.latestScorebugSize = size
      self?.applyScorebugOverlay()
    }

    startDiscovery()
    startPolling()
    startControlServer()
    ensureProductionReady()
    await syncEnabledSources()
    if launch.autoRecord {
      startRecording()
    } else {
      openCameras()
    }
  }

  public func shutdown() async {
    pollTimer?.invalidate()
    retentionTimer?.invalidate()
    if isRecording { await stopRecording() }
    router.removeAll()
    discovery?.stop()
    scorebug.stop()
    controlServer?.stop()
    controlServer = nil
  }

  /// True while this session is on generated test-pattern cameras rather than live ones.
  public var isUsingSimulatedCameras: Bool { sourceProfile == .synthetic4 }

  /// True while this session expects real cameras on the network, which is what makes an empty
  /// source list worth explaining to the operator.
  public var isUsingLiveCameras: Bool { Self.kind(for: sourceProfile).isLive }

  public func openAppSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }

  // MARK: - Discovery

  private static func resolveSourceProfile(
    launch: LaunchConfiguration,
    config: AppConfig
  ) -> SourceProfile {
    if let profile = launch.sourceProfile { return profile }
    return SourceProfile.forSimulatedCameras(config.useSimulatedCameras)
  }

  private static func kind(for profile: SourceProfile) -> SourceKind {
    switch profile {
    case .synthetic4: .synthetic
    case .file4: .file
    case .rtsp: .rtsp
    }
  }

  private func startDiscovery() {
    discovery?.stop()
    let kind = Self.kind(for: sourceProfile)
    selections = SourceSelectionRules.retaining(selections, kind: kind)
    selectionStore.save(selections)
    let discovery: SourceDiscovery? = switch sourceProfile {
    case .synthetic4:
      SourceProfileFactory.syntheticDiscovery(
        count: launch.syntheticCount,
        frameRate: launch.syntheticFrameRate,
        width: launch.syntheticWidth,
        height: launch.syntheticHeight,
        entropy: launch.syntheticEntropy,
        wireCodec: launch.cameraCodec,
        clock: clock
      )
    case .file4:
      SourceProfileFactory.fileDiscovery(fixtures: fixtureURLs(), clock: clock)
    case .rtsp:
      // Injected by the app target, so this module still never imports a transport.
      discoveryFactory?()
    }

    guard let discovery else {
      self.discovery = nil
      discoveryUnavailableReason = "No camera discovery is available for this profile"
      telemetry.mutate { $0.sourceAvailable = false }
      return
    }

    self.discovery = discovery
    discoveryUnavailableReason = nil
    telemetry.mutate {
      $0.sourceAvailable = discovery.kind.isLive
      $0.discoveryStatus = discovery.diagnostic
    }
    discovery.start { [weak self] discovered in
      Task { @MainActor in self?.applyDiscovery(discovered) }
    }
  }

  private func applyDiscovery(_ discovered: [DiscoveredSource]) {
    selections = SourceSelectionRules.merge(existing: selections, discovered: discovered)
    selectionStore.save(selections)
    cameraRecords = cameras.records
    noteEndpoints(of: discovered)
    telemetry.mutate {
      $0.discoveredSourceCount = discovered.count
      $0.discoveryStatus = discovery?.diagnostic ?? ""
    }
    rebuildRelocatedPipelines(discovered)
    pushDisplayNamesToTiles()
    Task { await syncEnabledSources() }
  }

  /// Repoints a tile whose camera came back on a different address.
  ///
  /// The identity survives the move, so the row, the archive and the timeline all continue. What
  /// cannot survive is the session: it is holding a socket to an address that has stopped answering,
  /// and only a new source object can connect to the new one.
  private func rebuildRelocatedPipelines(_ discovered: [DiscoveredSource]) {
    guard screen == .directing, let discovery else { return }

    for pipeline in router.activePipelines {
      guard
        let source = discovered.first(where: { $0.id == pipeline.sourceID }),
        let endpoint = CameraEndpoint(address: source.address),
        let built = pipelineEndpoints[pipeline.sourceID],
        built != endpoint
      else { continue }

      do {
        let replacement = try discovery.makeSource(for: source)
        observeStreamIdentity(replacement, id: pipeline.sourceID)
        try router.replaceSource(replacement, for: pipeline.sourceID)
        pipelineEndpoints[pipeline.sourceID] = endpoint
        statusMessage = "\(source.advertisedName) moved to \(endpoint.host)"
      } catch {
        if isRecording {
          statusMessage = "\(source.advertisedName): \(error)"
        }
      }
    }
  }

  // MARK: - Camera identity

  /// The camera bound to a row, if the operator has named it.
  public func boundCamera(for id: SourceID) -> CameraRecord? {
    guard let endpoint = endpoint(for: id) else { return nil }
    return cameras.binding(for: endpoint)?.cameraID.flatMap { cameras.record(id: $0) }
  }

  public func bindingOrigin(for id: SourceID) -> CameraBinding.Origin {
    guard let endpoint = endpoint(for: id) else { return .unbound }
    return cameras.binding(for: endpoint)?.origin ?? .unbound
  }

  public func endpoint(for id: SourceID) -> CameraEndpoint? {
    rowEndpoints[id]
  }

  private func noteEndpoints(of discovered: [DiscoveredSource]) {
    var endpoints: [SourceID: CameraEndpoint] = [:]
    for source in discovered {
      guard let endpoint = CameraEndpoint(address: source.address) else { continue }
      endpoints[source.id] = endpoint
    }
    rowEndpoints = endpoints
  }

  /// Points a row at a camera the operator has already named. The row's `SourceID` changes with it,
  /// because the identity — not the address — is what the archive is keyed by.
  public func bindCamera(_ cameraID: UUID, to id: SourceID) {
    guard let endpoint = endpoint(for: id) else { return }
    cameras.bind(endpoint: endpoint, to: cameraID)
    cameraRecords = cameras.records
    refreshDiscovery()
    pushDisplayNamesToTiles()
  }

  /// Names a row that has no camera yet, or renames the one it has.
  public func nameCamera(_ name: String, for id: SourceID) {
    guard let endpoint = endpoint(for: id) else { return }
    if let existing = cameras.binding(for: endpoint)?.cameraID {
      cameras.rename(existing, to: name)
    } else {
      cameras.adopt(endpoint: endpoint, name: name)
    }
    cameraRecords = cameras.records
    refreshDiscovery()
    pushDisplayNamesToTiles()
  }

  /// The address a cached camera is answering on right now, which is what makes "in use by" in the
  /// naming menu true rather than a guess from `lastKnownHost`.
  public func presentHost(forCamera cameraID: UUID) -> String? {
    cameras.endpoint(for: cameraID)?.host
  }

  /// Hands naming back to the camera, adopting the name it last advertised.
  public func followCamera(for id: SourceID) {
    guard let camera = boundCamera(for: id) else { return }
    cameras.followCamera(camera.id)
    cameraRecords = cameras.records
    refreshDiscovery()
    pushDisplayNamesToTiles()
  }

  /// What the camera at this row calls itself, if it says so at all.
  public func advertisement(for id: SourceID) -> StreamAdvertisement? {
    guard let endpoint = endpoint(for: id) else { return nil }
    return cameras.advertisement(for: endpoint)
  }

  /// Records a claim read off the wire — the SDP at `DESCRIBE`, then RTCP SDES while streaming.
  ///
  /// Both carry the same `CNAME`, and taking either means a camera is recognised before its first
  /// frame decodes rather than after.
  public func noteAdvertisement(_ advertisement: StreamAdvertisement, for id: SourceID) {
    guard let endpoint = endpoint(for: id), !advertisement.isEmpty else { return }
    cameras.note(advertisement, from: endpoint)
    cameraRecords = cameras.records
    if let tileIndex = selections.first(where: { $0.id == id })?.tileIndex,
       let cname = advertisement.cname, !cname.isEmpty {
      telemetry.mutateTile(tileIndex) { $0.cname = cname }
    }
    pushDisplayNamesToTiles()
  }

  public func forgetCamera(for id: SourceID) {
    guard let camera = boundCamera(for: id) else { return }
    cameras.forget(camera.id)
    cameraRecords = cameras.records
    refreshDiscovery()
    pushDisplayNamesToTiles()
  }

  private func observeStreamIdentity(_ source: FrameSource, id: SourceID) {
    guard let reporting = source as? StreamIdentityReporting else { return }
    reporting.onStreamAdvertisement = { [weak self] advertisement in
      DispatchQueue.main.async {
        self?.noteAdvertisement(advertisement, for: id)
      }
    }
  }

  /// Republishes the current endpoints through the identity layer, so a binding change is visible
  /// without waiting up to fifteen seconds for the next scan.
  private func refreshDiscovery() {
    guard let discovery else { return }
    let endpoints = refreshEndpoints(from: discovery)
    guard !endpoints.isEmpty else { return }

    let identities = cameras.resolve(endpoints: endpoints, advertisements: discovery.advertisements)
    let republished = endpoints.map { endpoint in
      DiscoveredSource(
        id: identities[endpoint]?.id ?? SourceID("camera-\(endpoint.host)"),
        kind: discovery.kind,
        advertisedName: identities[endpoint]?.name ?? endpoint.host,
        address: endpoint.url
      )
    }
    // Rows keyed by the old identity are dropped rather than left behind: after a rebinding they
    // describe a camera that is now on another row.
    selections = SourceSelectionRules.merge(existing: selections, discovered: republished)
      .filter { $0.isPresent || $0.isEnabled }
    selectionStore.save(selections)
    noteEndpoints(of: republished)
    pushDisplayNamesToTiles()
  }

  /// Grid and Output nameplates read `TileTelemetry.displayName`, which is otherwise only written
  /// when a pipeline starts. A rename in the cameras sheet has to reach those tiles immediately.
  private func pushDisplayNamesToTiles() {
    for pipeline in router.activePipelines {
      guard let name = selections.first(where: { $0.id == pipeline.sourceID })?.displayName else {
        continue
      }
      telemetry.mutateTile(pipeline.tileIndex) { $0.displayName = name }
    }
  }

  /// Keeps the last sweep's order — identified cameras first — so a rename does not bury a VM33
  /// under an unidentified RTSP host that sorts earlier by address.
  private func refreshEndpoints(from discovery: SourceDiscovery) -> [CameraEndpoint] {
    let fromSweep = discovery.currentSources.compactMap { CameraEndpoint(address: $0.address) }
    let fromRows = Array(Set(rowEndpoints.values))
    guard !fromSweep.isEmpty else {
      return fromRows.sorted { $0.host < $1.host }
    }
    var seen = Set(fromSweep)
    var ordered = fromSweep
    for endpoint in fromRows where !seen.contains(endpoint) {
      seen.insert(endpoint)
      ordered.append(endpoint)
    }
    return ordered
  }

  /// Simulated and live cameras share the five-source cap. Leaving the other kind in the list
  /// would look like live cameras.
  private func applySourceProfile(_ profile: SourceProfile) async {
    let profileChanged = profile != sourceProfile
    sourceProfile = profile
    telemetry.mutate { $0.sourceProfile = profile.rawValue }
    if profileChanged {
      if isRecording { await stopRecording() }
      router.removeAll()
      pipelineEndpoints.removeAll()
      scorebug.load(urlString: config.scoreboardURL)
    }
    startDiscovery()
    if profileChanged { openCameras() }
  }

  private func fixtureURLs() -> [URL] {
    let directory = launch.fixtureDirectory.map { URL(fileURLWithPath: $0) }
      ?? Bundle.main.bundleURL.appendingPathComponent("fixtures")
    let contents = (try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil
    )) ?? []
    return contents.filter { $0.pathExtension == "mp4" }.sorted { $0.path < $1.path }
  }

  // MARK: - Selection

  @discardableResult
  public func setEnabled(_ enabled: Bool, for id: SourceID) -> SourceSelectionRules.EnableResult {
    let result = SourceSelectionRules.setEnabled(enabled, for: id, in: &selections)
    if result == .rejectedAtCap {
      statusMessage = "Five sources maximum — turn one off first"
    } else {
      statusMessage = nil
      selectionStore.save(selections)
      switch result {
      case let .enabled(tileIndex):
        Task { await startSource(id: id, tileIndex: tileIndex) }
      case .disabled:
        stopSource(id)
      default:
        break
      }
    }
    return result
  }

  public func rename(_ name: String?, for id: SourceID) {
    SourceSelectionRules.rename(name, for: id, in: &selections)
    selectionStore.save(selections)
    if let pipeline = router.pipeline(for: id),
       let selection = selections.first(where: { $0.id == id }) {
      telemetry.mutateTile(pipeline.tileIndex) { $0.displayName = selection.displayName }
    }
  }

  public var enabledSelections: [SourceSelection] {
    SourceSelectionRules.enabled(in: selections)
  }

  // MARK: - Production

  /// Grid is always the root. Opening the picker or Settings must not rebuild it.
  public func ensureProductionReady() {
    screen = .directing
    UIApplication.shared.isIdleTimerDisabled = true
    if !scorebugLoaded {
      scorebug.load(urlString: config.scoreboardURL)
      scorebugLoaded = true
    }
  }

  public func openCameras() {
    ensureProductionReady()
    discovery?.setPeriodicSearch(true)
    discovery?.searchNow()
    activeSheet = .cameras
  }

  public func dismissCameras() {
    activeSheet = nil
    discovery?.setPeriodicSearch(false)
  }

  public func enterDirecting() async {
    ensureProductionReady()
    await syncEnabledSources()
    dismissCameras()
  }

  /// Called when the scene goes to the background. Recording is stopped rather than paused: the
  /// hardware encoder is unavailable to a suspended app, so a recording that survives suspension
  /// only produces a truncated file and a set of sessions nobody closes.
  public func prepareForSuspension() async {
    guard isRecording else { return }
    statusMessage = "Recording stopped — app moved to the background"

    // Stopping is asynchronous — four segmented writers and the program file all have to finalise —
    // and iOS suspends a backgrounded app well before that finishes. Without an explicit assertion
    // the process freezes mid-flush and leaves exactly the truncated files this method exists to
    // prevent, so the work has to be wrapped in one.
    let assertion = BackgroundAssertion(name: "finalise-recording")
    await stopRecording()
    assertion.end()
  }

  public func returnToSources() async {
    openCameras()
  }

  /// Starts missing cameras and stops disabled ones. Already-running tiles are left alone so
  /// opening the picker cannot glitch the programme or the archives.
  private func syncEnabledSources() async {
    ensureProductionReady()
    let enabled = enabledSelections
    let wanted = Set(enabled.map(\.id))
    for pipeline in router.activePipelines where !wanted.contains(pipeline.sourceID) {
      stopSource(pipeline.sourceID)
    }
    for selection in enabled {
      guard let tileIndex = selection.tileIndex else { continue }
      await startSource(id: selection.id, tileIndex: tileIndex)
    }
    if router.currentProgramTile == nil, let first = enabled.first?.tileIndex {
      router.selectProgram(tileIndex: first)
    }
    applyAudioContributors()
  }

  private func startSource(id: SourceID, tileIndex: Int) async {
    if let existing = router.pipeline(for: id) {
      if existing.tileIndex != tileIndex || !existing.sourceIsRunning {
        stopSource(id)
      } else {
        return
      }
    }
    if router.pipeline(at: tileIndex) != nil {
      return
    }
    guard let discovery else { return }
    guard let selection = selections.first(where: { $0.id == id }) else { return }
    guard let discovered = SourceSelectionRules.startableSource(
      id: id,
      among: discovery.currentSources
    ) else { return }
    do {
      let source = try discovery.makeSource(for: discovered)
      observeStreamIdentity(source, id: id)
      let pipeline = SourcePipeline(
        sourceID: id,
        tileIndex: tileIndex,
        source: source,
        converter: converter,
        telemetry: telemetry
      )
      router.add(pipeline)
      try pipeline.start()
      router.audioMixer.start()
      pipelineEndpoints[id] = CameraEndpoint(address: discovered.address)
      telemetry.mutateTile(tileIndex) { $0.displayName = selection.displayName }
      if router.currentProgramTile == nil {
        router.selectProgram(tileIndex: tileIndex)
      }
      applyAudioContributors()
      if isRecording, let recordingID {
        attachArchive(to: pipeline, recordingID: recordingID)
        attachProxy(to: pipeline)
      }
    } catch {
      if let message = OperatorAlert.cameraFailure(
        displayName: selection.displayName,
        detail: "\(error)",
        isRecording: isRecording
      ) {
        statusMessage = message
      }
    }
  }

  private func stopSource(_ id: SourceID) {
    guard let pipeline = router.pipeline(for: id) else { return }
    pipeline.setArchive(nil)
    pipeline.setProxy(nil)
    if let writer = writers.removeValue(forKey: id) {
      writer.supersede()
      Task { await writer.finish() }
    }
    proxies[id] = nil
    pipelineEndpoints[id] = nil
    router.remove(tileIndex: pipeline.tileIndex)
    applyAudioContributors()
  }

  private func activateEnabledSources() async {
    await syncEnabledSources()
  }

  /// Points the mixer at whichever sources are ticked for audio. Called after activation and again
  /// whenever the operator changes a toggle, so the mix follows the switches live.
  public func applyAudioContributors() {
    let ids = Set(SourceSelectionRules.audioContributors(in: selections).map(\.id))
    router.setAudioContributors(ids)
  }

  public func setUsesAudio(_ usesAudio: Bool, for id: SourceID) {
    SourceSelectionRules.setUsesAudio(usesAudio, for: id, in: &selections)
    selectionStore.save(selections)
    applyAudioContributors()
  }

  public func selectProgram(tileIndex: Int) {
    guard router.pipeline(at: tileIndex) != nil else { return }
    router.selectProgram(tileIndex: tileIndex)
    applyScorebugOverlay()
  }

  // MARK: - Recording

  public func toggleRecording() {
    if isRecording {
      Task { await stopRecording() }
    } else {
      startRecording()
    }
  }

  /// Starting is deliberately not all-or-nothing. Each camera and the program encoder can fail
  /// on its own, and the app stays in the recording state as long as anything is writing —
  /// otherwise a single failure strands live writers that `stopRecording` would refuse to touch.
  public func startRecording() {
    guard !isRecording else { return }
    let now = clock.now
    let recordingID: Int64
    do {
      recordingID = try index.beginRecording(at: now)
    } catch {
      statusMessage = "Could not start recording: \(error)"
      return
    }
    self.recordingID = recordingID

    do {
      for pipeline in router.activePipelines {
        // The proxy is a JPEG a second from the decoded picture, which the scrub timeline needs
        // whether or not the archive is keeping up.
        attachArchive(to: pipeline, recordingID: recordingID)
        attachProxy(to: pipeline)
      }

    } catch {
      statusMessage = "Could not start every camera: \(error)"
    }

    // Losing program output is not a failure of the recording: the per-camera archives are the
    // part of a game that cannot be re-created afterwards.
    do {
      try programEncoder.start(at: now)
      if let filename = programEncoder.outputURL?.lastPathComponent {
        try? index.setProgramFilename(filename, for: recordingID)
      }
    } catch {
      let message = "Program output unavailable: \(error)"
      statusMessage = message
      telemetry.mutate { $0.dvr.lastError = message }
    }

    isRecording = true
    telemetry.mutate {
      $0.dvr.isRecording = true
      $0.dvr.recordingStartedAt = now.seconds
    }
    startRetentionSweeps()
  }

  private func attachProxy(to pipeline: SourcePipeline) {
    let proxy = ProxyStore(
      sourceID: pipeline.sourceID,
      tileIndex: pipeline.tileIndex,
      index: index,
      telemetry: telemetry,
      converter: converter,
      clock: clock
    )
    do {
      try proxy.prepare()
      proxies[pipeline.sourceID] = proxy
      pipeline.setProxy(proxy)
    } catch {
      statusMessage = "\(pipeline.displayName): \(error)"
    }
  }

  /// Gives one camera a writer for the open recording, replacing any it already had.
  ///
  /// Also the recovery path for a camera that changes format mid-recording: one fMP4 track cannot
  /// hold two formats, so the writer asks to be replaced and the archive continues in a new
  /// segment. Segments are independent, and the sequence numbering carries on, so the recording
  /// reads back as one timeline.
  private func attachArchive(to pipeline: SourcePipeline, recordingID: Int64) {
    // A camera that sends no audio must not be given an audio track: the segmented writer waits
    // for audio it will never receive and stops accepting video a few seconds in.
    let settings = SegmentWriterSettings.from(
      config: config,
      includesAudio: pipeline.hasDeliveredAudio && launch.archiveAudio
    )
    let writer = SegmentWriter(
      sourceID: pipeline.sourceID,
      tileIndex: pipeline.tileIndex,
      recordingID: recordingID,
      index: index,
      telemetry: telemetry,
      settings: settings,
      clock: clock,
      onFormatChange: { [weak self] sourceID in
        Task { @MainActor in self?.reopenArchive(for: sourceID) }
      }
    )
    do {
      try writer.prepare()
      let existing = writers[pipeline.sourceID]
      writers[pipeline.sourceID] = writer
      pipeline.setArchive(writer)
      if let existing {
        existing.supersede()
        Task { await existing.finish() }
      }
    } catch {
      statusMessage = "\(pipeline.displayName): \(error)"
    }
  }

  private func reopenArchive(for sourceID: SourceID) {
    guard isRecording, let recordingID, let pipeline = router.pipeline(for: sourceID) else { return }
    attachArchive(to: pipeline, recordingID: recordingID)
  }

  public func stopRecording() async {
    guard isRecording else { return }
    isRecording = false
    retentionTimer?.invalidate()
    retentionTimer = nil
    setRecordingStage("detaching")

    for pipeline in router.activePipelines {
      pipeline.setArchive(nil)
      pipeline.setProxy(nil)
    }
    // Concurrently, not one after another: flushing a segmented writer takes seconds on this
    // hardware, and three cameras finished in series is the difference between a pause and a
    // hang from the operator's point of view.
    setRecordingStage("finishing archives")
    let flushes = writers.map { sourceID, writer in
      (label: sourceID.rawValue, task: Task { await writer.finish() })
    }
    // Wait on all of them under one deadline. Awaiting each in turn gave every camera its own
    // 20 seconds, so three cameras could take a minute to stop even though the flushes themselves
    // were already running in parallel.
    // A healthy flush takes well under a second; the deadline only exists to stop a pathological
    // writer from wedging the stop path.
    let deadline = 20.0
    let startedFlush = Date()
    let waits = flushes.map { flush in
      Task<Bool, Never> { await Self.complete(within: deadline, await flush.task.value) }
    }
    var stalled: [String] = []
    for (offset, wait) in waits.enumerated() where await wait.value == false {
      stalled.append(flushes[offset].label)
    }
    let elapsed = String(format: "%.1f", Date().timeIntervalSince(startedFlush))
    if stalled.isEmpty {
      telemetry.mutate { $0.dvr.lastFlushSeconds = elapsed }
    } else {
      report("archives did not finish within \(Int(deadline))s — may be truncated: "
        + stalled.joined(separator: ", "))
    }
    writers.removeAll()
    setRecordingStage("closing proxies")
    for proxy in proxies.values { proxy.close() }
    proxies.removeAll()

    setRecordingStage("finishing program")
    let programEncoder = self.programEncoder
    let programURL = ProgramURL()
    await finishWithDeadline("program") { await programURL.set(programEncoder.finish()) }
    if let url = await programURL.value {
      let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
      programOutput = url
      telemetry.mutate { $0.dvr.programOutput = "\(url.lastPathComponent) \(bytes ?? 0)" }
    }

    setRecordingStage("closing index")
    if let recordingID {
      try? index.endRecording(recordingID, at: clock.now)
    }
    recordingID = nil
    telemetry.mutate { $0.dvr.isRecording = false }
    setRecordingStage("idle")
  }

  private func setRecordingStage(_ stage: String) {
    telemetry.mutate { $0.recordingStage = stage }
  }

  /// `AVAssetWriter.finishWriting()` can block for as long as it likes — in practice, when an
  /// input was created but never fed a sample, it never returns at all. Stopping a recording is
  /// a user-facing action and must not depend on that, so a writer that overruns is abandoned
  /// and named in the status line instead of wedging the whole stop path.
  private func finishWithDeadline(
    _ label: String,
    seconds: Double = 20,
    _ work: @escaping @Sendable () async -> Void
  ) async {
    guard await Self.complete(within: seconds, await work()) else {
      report("\(label) did not finish within \(Int(seconds))s — file may be truncated")
      return
    }
  }

  private func report(_ message: String) {
    telemetry.mutate { $0.dvr.lastError = message }
    statusMessage = message
  }

  /// Runs `work` and reports whether it finished before the deadline.
  ///
  /// Deliberately not a task group: a group waits for every child before it returns, and
  /// AVFoundation's finish is not cancellable, so a group would wait out the very hang this exists
  /// to escape. The overrunning task is left running — if it does eventually finish, the file is
  /// still written.
  private static func complete(
    within seconds: Double,
    _ work: @autoclosure @escaping @Sendable () async -> Void
  ) async -> Bool {
    let outcome = Outcome()
    return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      Task {
        await work()
        if outcome.claim() { continuation.resume(returning: true) }
      }
      Task {
        try? await Task.sleep(for: .seconds(seconds))
        if outcome.claim() { continuation.resume(returning: false) }
      }
    }
  }

  /// Carries the program file's URL out of the deadline-guarded closure, which cannot capture and
  /// mutate local state across isolation boundaries.
  private actor ProgramURL {
    private(set) var value: URL?

    func set(_ url: URL?) { value = url }
  }

  /// Lets exactly one of two racing tasks resume a continuation.
  private final class Outcome: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      if claimed { return false }
      claimed = true
      return true
    }
  }

  private func startRetentionSweeps() {
    retentionTimer?.invalidate()
    retentionTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.sweepRetention() }
    }
  }

  public func sweepRetention() {
    guard let sweep = try? retention.sweep(
      retentionHours: config.retentionHours,
      minimumFreeDiskBytes: config.minimumFreeDiskBytes
    ) else { return }
    telemetry.mutate {
      $0.dvr.retentionSwept += UInt64(sweep.removedSegments)
      $0.dvr.retentionReclaimedBytes += UInt64(max(0, sweep.reclaimedBytes))
    }
    if sweep.triggeredByDiskPressure {
      statusMessage = "Low storage — retention window halved"
    }
  }

  // MARK: - Scrub and replay

  /// Returns false when the tile has nothing to scrub through, having said so on screen.
  ///
  /// Worth refusing rather than starting: scrubbing pauses the tile, and a tile frozen on its last
  /// live frame with no explanation is how "the DVR is broken" looks from the operator's side of the
  /// glass. The 1 fps proxy stills are what the drag shows, and they start with the recording, so
  /// before Record there is genuinely no past to show.
  @discardableResult
  public func beginScrub(tileIndex: Int) -> Bool {
    guard let pipeline = router.pipeline(at: tileIndex) else { return false }
    guard availableHistorySeconds(tileIndex: tileIndex) > 0 else {
      statusMessage = isRecording
        ? "Nothing to scrub yet — still building history"
        : "Nothing to scrub — start recording first"
      return false
    }
    pipeline.beginScrubbing()
    applyScorebugOverlay()
    return true
  }

  /// `offsetSeconds` is negative: how far behind the live edge the finger currently is.
  public func updateScrub(tileIndex: Int, offsetSeconds: Double) {
    guard let pipeline = router.pipeline(at: tileIndex) else { return }
    let target = (pipeline.liveEdge ?? clock.now) + offsetSeconds
    guard let still = proxyReader.still(for: pipeline.sourceID, at: target),
          let buffer = PixelBufferDrawing.makeBGRA(from: still.image) else { return }
    pipeline.showScrubStill(buffer, offsetSeconds: offsetSeconds)
  }

  public func endScrub(
    tileIndex: Int,
    offsetSeconds: Double,
    rate: Float = 1,
    playDuration: TimeInterval? = nil
  ) {
    guard let pipeline = router.pipeline(at: tileIndex) else { return }
    let history = availableHistorySeconds(tileIndex: tileIndex)
    guard !ScrubMapping.shouldReturnToLive(
      offsetSeconds: offsetSeconds,
      historySeconds: history
    ) else {
      pipeline.returnToLive()
      applyScorebugOverlay()
      return
    }

    // R6 is measured from here — the instant the finger leaves the glass — to the first decoded
    // frame reaching the tile. Timing anything later would flatter the number by excluding the
    // segment assembly, which is the slowest part.
    let releasedAt = DispatchTime.now().uptimeNanoseconds
    let liveEdge = pipeline.liveEdge ?? clock.now
    let target = liveEdge + offsetSeconds
    let sourceID = pipeline.sourceID
    let assembler = self.assembler
    // The archive runs at whatever the camera sends, so the replay pump has to follow the source
    // rather than any setting of ours.
    let frameRate = pipeline.format?.frameRate ?? 30

    // Assembly stages up to 64 segment files, which is real disk work. Doing it inline left
    // the main actor blocked for the whole of it, so the UI froze at exactly the moment the
    // operator expected a response and the measured latency included a stalled render loop.
    Task { [weak self] in
      let assembly: SegmentAssembler.Assembly
      do {
        assembly = try await Task.detached(priority: .userInitiated) {
          try assembler.assemblePlaylist(
            sourceID: sourceID,
            from: target,
            to: liveEdge,
            maximumSegments: 64
          )
        }.value
      } catch {
        await MainActor.run {
          // The drag already showed the past via JPEGs. Replay needs closed archive segments,
          // which do not exist yet in the first few seconds, and never exist at T3. Stay on
          // the still; Return to live is on the tile.
          self?.statusMessage = "Holding still — archive not ready to replay yet"
          self?.applyScorebugOverlay()
        }
        return
      }

      await self?.startReplay(
        tileIndex: tileIndex,
        assembly: assembly,
        target: target,
        offsetSeconds: offsetSeconds,
        frameRate: frameRate,
        rate: rate,
        playDuration: playDuration,
        releasedAt: releasedAt
      )
    }
  }

  /// Instant-replay hotkey: rewind this many seconds from the live edge, play that duration of
  /// tape at `rate`, then return this tile to live.
  public func startInstantReplay(tileIndex: Int, seconds: Double, rate: Float) {
    guard seconds > 0 else { return }
    guard beginScrub(tileIndex: tileIndex) else { return }
    let history = availableHistorySeconds(tileIndex: tileIndex)
    let offset = -min(seconds, max(history, 0))
    updateScrub(tileIndex: tileIndex, offsetSeconds: offset)
    endScrub(
      tileIndex: tileIndex,
      offsetSeconds: offset,
      rate: rate,
      playDuration: seconds
    )
    applyScorebugOverlay()
  }

  private func startReplay(
    tileIndex: Int,
    assembly: SegmentAssembler.Assembly,
    target: WallClock,
    offsetSeconds: Double,
    frameRate: Double,
    rate: Float,
    playDuration: TimeInterval?,
    releasedAt: UInt64
  ) async {
    guard let pipeline = router.pipeline(at: tileIndex) else { return }

    // File-relative: the first assembled sample is t=0 for the decoder, even though fragment
    // PTS is counted from the start of the recording.
    let startOffset = max(0, target - assembly.startWall)
    if !ScrubMapping.shouldStartReplay(
      assemblyDuration: assembly.duration,
      startOffset: startOffset
    ) {
      // A playlist that is shorter than the scrub would play for a fraction of a second and
      // snap to live — which is how "rewind never works" looks. Keep the proxy still.
      pipeline.revertToScrubbing()
      statusMessage = "Holding still — archive not ready to replay yet"
      applyScorebugOverlay()
      return
    }
    let telemetry = self.telemetry
    let reported = FirstFrameStamp()
    let decoder = ReplayDecoder(
      configuration: .init(
        url: assembly.url,
        startOffset: startOffset,
        frameRate: frameRate,
        port: ReplayDecoder.loopbackPort(forTile: tileIndex),
        rate: rate,
        playDuration: playDuration
      ),
      onFrame: { [weak pipeline] buffer, time, played in
        if reported.claim() {
          let elapsed = Double(DispatchTime.now().uptimeNanoseconds - releasedAt) / 1_000_000
          telemetry.mutateTile(tileIndex) { $0.replayLatencyMilliseconds = elapsed }
        }
        pipeline?.deliverReplayFrame(
          buffer,
          presentationTime: time,
          offsetSeconds: offsetSeconds + played
        )
      },
      onFinish: { [weak self] in
        Task { @MainActor in self?.returnToLive(tileIndex: tileIndex) }
      },
      onFailure: { [weak self] error in
        Task { @MainActor in
          self?.statusMessage = "Holding still — replay failed: \(error)"
          self?.telemetry.mutate { $0.lastReplayError = "\(error)" }
          self?.router.pipeline(at: tileIndex)?.revertToScrubbing()
          self?.applyScorebugOverlay()
        }
      }
    )

    do {
      try await pipeline.beginReplay(decoder, offsetSeconds: offsetSeconds)
      statusMessage = nil
      telemetry.mutate { $0.lastReplayError = "" }
      applyScorebugOverlay()
    } catch {
      statusMessage = "Holding still — replay failed: \(error)"
      telemetry.mutate { $0.lastReplayError = "\(error)" }
      applyScorebugOverlay()
    }
  }

  public func returnToLive(tileIndex: Int) {
    router.pipeline(at: tileIndex)?.returnToLive()
    if router.currentProgramTile == tileIndex {
      router.programRenderer.prepareForLive()
    }
    applyScorebugOverlay()
  }

  /// Scorebug burns into Output only while that camera is live. A rewind of Output drops the
  /// overlay without unloading the page; a rewind of a non-Output tile leaves it in place.
  private func programSourceIsRewinding() -> Bool {
    guard let index = router.currentProgramTile else { return false }
    let state = telemetry.snapshot.tiles.first { $0.index == index }?.state
    return state == .scrubbing || state == .replaying
  }

  private func applyScorebugOverlay() {
    if programSourceIsRewinding() {
      compositor?.setOverlay(nil, size: .zero)
      return
    }
    if let image = latestScorebugImage {
      compositor?.setOverlay(image, size: latestScorebugSize)
    }
  }

  /// The scrubbable depth for a tile, used to scale the drag gesture.
  ///
  /// Measured from proxy stills of the current recording, not from completed archive segments.
  /// Segments close every `segmentSeconds` (6 by default) and the previous gate required the last
  /// closed file to be less than 5 s old — so scrubbing was dark for most of every segment, and
  /// dark forever at T3 where nothing is archived. Stills are 1 fps from the first second.
  public func availableHistorySeconds(tileIndex: Int) -> Double {
    guard isRecording, let pipeline = router.pipeline(at: tileIndex) else { return 0 }
    let now = pipeline.liveEdge ?? clock.now
    let floor: WallClock
    if let started = telemetry.snapshot.dvr.recordingStartedAt {
      // A still can land a fraction of a second before `recordingStartedAt` if a frame was already
      // in flight when Record was pressed.
      floor = WallClock(seconds: started) - 1
    } else {
      floor = now - 3
    }
    guard let bounds = try? index.proxyTimelineBounds(for: pipeline.sourceID, after: floor)
    else { return 0 }

    // Stills are 1 fps. More than a few seconds behind live means this recording is not writing them.
    guard now - bounds.end < 3 else { return 0 }
    return max(0, now - bounds.start)
  }

  // MARK: - Settings, export, perf

  public func update(config newConfig: AppConfig) {
    let wantsSimulated = newConfig.useSimulatedCameras
    let sessionIsSimulated = isUsingSimulatedCameras
    persistedConfig = newConfig
    configStore.save(newConfig)
    var session = Self.applying(launch, to: newConfig)
    session.replaySlowMotionRate = AppConfig.clampedReplaySlowMotionRate(session.replaySlowMotionRate)
    // Launch `-debugHUD` is a one-time overlay. Saving Settings must be able to hide the HUD.
    session.showDebugHUD = newConfig.showDebugHUD
    let scoreboardChanged = session.scoreboardURL != config.scoreboardURL
    config = session
    applyDisplayLatencyCap()
    if scoreboardChanged {
      scorebug.load(urlString: session.scoreboardURL)
      scorebugLoaded = true
    }
    if wantsSimulated != sessionIsSimulated {
      Task { await applySourceProfile(SourceProfile.forSimulatedCameras(wantsSimulated)) }
    }
  }

  /// Launch arguments overlay the running session and are forgotten when the process exits.
  /// Writing them back is how a test URL became the saved scoreboard, so they never touch disk.
  private static func applying(_ launch: LaunchConfiguration, to config: AppConfig) -> AppConfig {
    var config = config
    if let url = launch.scoreboardURL { config.scoreboardURL = url }
    if let seconds = launch.segmentSeconds { config.segmentSeconds = seconds }
    if let codec = launch.programCodec { config.programCodec = codec }
    if let hud = launch.debugHUD { config.showDebugHUD = hud }
    return config
  }

  public func setDisplayLatencyCap(enabled: Bool) {
    var next = persistedConfig
    next.displayLatencyCapEnabled = enabled
    if enabled {
      next.displayLatencyCapMilliseconds = AppConfig.displayLatencyCapDefaultMilliseconds
    }
    update(config: next)
  }

  public func setDisplayLatencyCapMilliseconds(_ milliseconds: Double) {
    var next = persistedConfig
    next.displayLatencyCapEnabled = true
    next.displayLatencyCapMilliseconds = AppConfig.clampedDisplayLatencyCap(milliseconds)
    update(config: next)
  }

  private func applyDisplayLatencyCap() {
    cameras.playout.setCap(
      milliseconds: config.displayLatencyCapEnabled
        ? config.displayLatencyCapMilliseconds
        : nil
    )
  }

  public func export(tileIndex: Int, lastSeconds: Double) {
    guard let pipeline = router.pipeline(at: tileIndex) else { return }
    let end = pipeline.liveEdge ?? clock.now
    do {
      lastExport = try exporter.export(
        sourceID: pipeline.sourceID,
        displayName: pipeline.displayName,
        from: end - lastSeconds,
        to: end
      )
      statusMessage = "Exported \(lastExport?.url.lastPathComponent ?? "")"
    } catch {
      statusMessage = "Export failed: \(error)"
    }
  }

  public func listedRecordings() -> [RecordingSummary] {
    (try? index.recordings()) ?? []
  }

  public func recordingCameraName(for sourceID: SourceID) -> String {
    if let selection = selections.first(where: { $0.id == sourceID }) {
      return selection.displayName
    }
    if let record = cameraRecords.first(where: { SourceID($0.id.uuidString) == sourceID }) {
      return record.name
    }
    return sourceID.rawValue
  }

  public func shareRecording(
    _ recording: RecordingSummary,
    cameras: [(SourceID, String)],
    includeProgram: Bool
  ) {
    do {
      let urls = try exporter.exportRecording(
        recording,
        cameras: cameras.map { (sourceID: $0.0, name: $0.1) },
        includeProgram: includeProgram
      )
      guard !urls.isEmpty else {
        statusMessage = "Nothing to export for that recording"
        return
      }
      lastRecordingShare = urls
      isSharingRecordings = true
    } catch {
      statusMessage = "Export failed: \(error)"
    }
  }

  public func runEncodeProbe(
    upTo maximum: Int = 8,
    framesPerSession: Int = 1,
    width: Int = 1920,
    height: Int = 1080
  ) {
    let result = EncodeSessionProbe.probe(
      upTo: maximum,
      width: width,
      height: height,
      framesPerSession: framesPerSession
    )
    probeResult = result
    statusMessage = result.summary
    telemetry.mutate { $0.encodeProbe = result.summary }
  }

  /// Off the main actor: this one deliberately runs for tens of seconds.
  public func runThroughputProbe(sessions: Int, seconds: Double, height: Int, hevc: Bool) {
    statusMessage = "Measuring sustained encode throughput…"
    telemetry.mutate { $0.encodeProbe = "throughput probe running…" }
    Task.detached(priority: .userInitiated) { [telemetry] in
      let result = EncodeSessionProbe.sustainedThroughput(
        sessions: sessions,
        seconds: seconds,
        width: height * 16 / 9,
        height: height,
        codec: hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264
      )
      telemetry.mutate { $0.encodeProbe = result.summary }
    }
  }

  public func runWriterProbe(options: [String: String] = [:]) {
    statusMessage = "Running writer probe…"
    let codec = config.programCodec
    Task.detached(priority: .userInitiated) { [telemetry] in
      let result = AssetWriterProbe.probe(options: options, defaultCodec: codec)
      telemetry.mutate { $0.encodeProbe = result.summary }
      await MainActor.run { [weak self] in self?.statusMessage = result.summary }
    }
  }

  // MARK: - Telemetry polling

  private func startPolling() {
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.pollTelemetry() }
    }
  }

  private func pollTelemetry() {
    telemetry.recordConverter(converter.currentStatistics)
    let status = statusMessage ?? ""
    let cpu = ProcessLoad.cpuPercent()
    let summaries = selections.enumerated().map { offset, selection in
      SourceSummary(
        index: offset + 1,
        name: selection.displayName,
        isEnabled: selection.isEnabled,
        usesAudio: selection.usesAudio,
        isPresent: selection.isPresent,
        tileIndex: selection.tileIndex
      )
    }
    let mix = router.audioMixer.currentStatistics
    let scorebugStatus = scorebug.status
    let composedFrames = compositor?.frameCount ?? 0
    let discoveryStatus = discovery?.diagnostic ?? ""
    let displayLatency = cameras.playout.programMilliseconds
    telemetry.mutate {
      $0.statusMessage = status
      $0.sources = summaries
      $0.scorebug = scorebugStatus
      $0.composedFrames = composedFrames
      $0.audioMixContributors = mix.contributors
      $0.audioMixSeconds = (mix.emittedSeconds * 10).rounded() / 10
      $0.cpuPercent = (cpu * 10).rounded() / 10
      $0.cpuCores = ProcessLoad.coreCount
      $0.availableMemoryMB = ProcessLoad.availableMemoryMB()
      $0.physFootprintMB = ProcessLoad.physFootprintMB()
      $0.discoveryStatus = discoveryStatus
      $0.displayLatencyMilliseconds = displayLatency
    }
    var liveDecodeSessions = 0
    for pipeline in router.activePipelines {
      let format = pipeline.format
      let connections = pipeline.connections
      let receive = pipeline.receiveStats
      liveDecodeSessions += receive.decodeSessions
      telemetry.mutateTile(pipeline.tileIndex) { tile in
        tile.sourceWidth = format?.width ?? 0
        tile.sourceHeight = format?.height ?? 0
        tile.sourceFrameRate = format?.frameRate ?? 0
        tile.sourcePixelFormat = format.map { SourceFormat.fourCharacterCode($0.pixelFormat) } ?? ""
        tile.connections = connections
        tile.capturedFrames = receive.captured
        tile.poolMisses = receive.poolMisses
        tile.formatMisses = receive.formatMisses
        tile.packetsLost = receive.packetsLost
        tile.sourceStatus = receive.status ?? ""
        let elapsed = receive.waitingSeconds + receive.deliverySeconds
        tile.receiveWaitFraction = elapsed > 0 ? receive.waitingSeconds / elapsed : 0
        tile.deliveryMilliseconds = receive.captured > 0
          ? (receive.deliverySeconds / Double(receive.captured)) * 1000
          : 0
        tile.arrivalGapMaxMilliseconds = receive.arrivalGapMaxMilliseconds
        tile.arrivalGapWasKeyframe = receive.arrivalGapWasKeyframe
        tile.deliverMaxMilliseconds = receive.deliverMaxMilliseconds
        tile.pacingSpreadMilliseconds = receive.pacingSpreadMilliseconds
        tile.releaseGapMaxMilliseconds = receive.releaseGapMaxMilliseconds
        tile.playoutMilliseconds = receive.playoutMilliseconds
        tile.playoutLateFrames = receive.playoutLateFrames
        tile.playoutDepth = receive.playoutDepth
      }
      // Remembered against the camera, not the tile, so a camera that needs an unusually large
      // buffer starts there next time instead of stuttering its way back to it.
      if receive.playoutMilliseconds > 0 {
        cameras.rememberPlayout(receive.playoutMilliseconds, for: pipeline.sourceID)
      }
      if isRecording {
        let detail = receive.status ?? ""
        let previous = announcedCameraStatus[pipeline.sourceID] ?? ""
        if detail != previous {
          announcedCameraStatus[pipeline.sourceID] = detail
          if let message = OperatorAlert.cameraFailure(
            displayName: pipeline.displayName,
            detail: detail,
            isRecording: true
          ) {
            statusMessage = message
          }
        }
      }
    }
    if !isRecording { announcedCameraStatus.removeAll() }
    telemetry.recordLiveDecodeSessions(liveDecodeSessions)
    snapshot = telemetry.snapshot
    applyScorebugOverlay()
  }

  // MARK: - Control channel

  /// `gsdirector://` commands. Ignored unless the app was launched with `uiTest` (D7), so the
  /// automation surface cannot be reached by accident in normal use.
  @discardableResult
  public func handle(url: URL) -> Bool {
    guard let command = ControlChannel.command(from: url) else { return false }
    if case .configure = command {} else {
      guard launch.isUITest else { return false }
    }

    switch command {
    case let .configure(values):
      launch.apply(queryItems: values)
      if launch.useTestClock, testClock == nil { statusMessage = "Test clock requires relaunch" }
      if let profile = launch.sourceProfile {
        Task { await applySourceProfile(profile) }
      } else {
        startDiscovery()
      }
    case let .scrub(tile, offset):
      beginScrub(tileIndex: tile)
      updateScrub(tileIndex: tile, offsetSeconds: offset)
      endScrub(tileIndex: tile, offsetSeconds: offset)
    case let .returnToLive(tile):
      returnToLive(tileIndex: tile)
    case let .record(on):
      if on { startRecording() } else { Task { await stopRecording() } }
    case .startDirecting:
      Task { await enterDirecting() }
    case let .selectProgram(tile):
      selectProgram(tileIndex: tile)
    case let .enableSource(index, on):
      guard index >= 0, index < selections.count else { return false }
      setEnabled(on, for: selections[index].id)
    case let .sourceAudio(index, on):
      guard index >= 0, index < selections.count else { return false }
      setUsesAudio(on, for: selections[index].id)
    case let .renameSource(index, name):
      guard index >= 0, index < selections.count else { return false }
      rename(name, for: selections[index].id)
    case let .nameCamera(index, name):
      guard index >= 0, index < selections.count else { return false }
      nameCamera(name, for: selections[index].id)
    case let .bindCamera(index, name):
      guard
        index >= 0, index < selections.count,
        let record = cameraRecords.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame })
      else { return false }
      bindCamera(record.id, to: selections[index].id)
    case let .forgetCamera(index):
      guard index >= 0, index < selections.count else { return false }
      forgetCamera(for: selections[index].id)
    case .searchCameras:
      discovery?.searchNow()
    case let .advanceClock(seconds):
      testClock?.advance(by: seconds)
      sweepRetention()
    case let .probeEncoders(maximum, framesPerSession, width, height):
      runEncodeProbe(upTo: maximum, framesPerSession: framesPerSession, width: width, height: height)
    case let .probeThroughput(sessions, seconds, height, hevc):
      runThroughputProbe(sessions: sessions, seconds: seconds, height: height, hevc: hevc)
    case let .probeWriter(options):
      runWriterProbe(options: options)
    case .dumpState:
      pollTelemetry()
      stateDumper.dump(snapshot)
    case .reset:
      telemetry.reset()
      testClock?.reset()
      statusMessage = nil
    }
    return true
  }

  /// Same commands over loopback HTTP. `dump-state` answers with the snapshot inline so a
  /// script does not have to reach into the app container to read it.
  private func handleFromControlServer(url: URL) -> Data? {
    guard handle(url: url) else { return nil }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .prettyPrinted, .sortedKeys ]
    if ControlChannel.command(from: url) == .dumpState, let data = try? encoder.encode(snapshot) {
      return data
    }
    return Data(#"{"ok":true}"#.utf8)
  }

  private func startControlServer() {
    guard launch.isUITest, controlServer == nil else { return }
    let server = ControlServer { [weak self] url in
      // NWListener calls back on its own queue; every command mutates main-actor state.
      DispatchQueue.main.sync {
        MainActor.assumeIsolated { self?.handleFromControlServer(url: url) }
      }
    }
    do {
      try server.start()
      controlServer = server
      telemetry.mutate { snapshot in
        snapshot.controlServer = "\(ControlServer.defaultPort) \(ControlServer.localAddresses().joined(separator: ","))"
      }
    } catch {
      statusMessage = "Control server unavailable: \(error.localizedDescription)"
    }
  }
}
