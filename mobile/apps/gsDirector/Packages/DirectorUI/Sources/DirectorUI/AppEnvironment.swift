import AVFoundation
import Foundation
import Observation
import DirectorCore
import DirectorDVR
import DirectorPipeline
import DirectorRTMP
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
  /// What Settings edits and what survives a relaunch. Launch arguments never write here.
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
  public private(set) var isStreaming = false
  public private(set) var streamMegabitsPerSecond = 0.0
  public private(set) var streamDroppedPackets: UInt64 = 0
  public let pictureInPicture = ProgramPictureInPicture()
  private var isInBackground = false
  public private(set) var statusMessage: String?

  public func dismissStatusMessage() {
    statusMessage = nil
  }

  public private(set) var lastExport: ExportService.Result?
  public private(set) var lastRecordingShare: [URL] = []
  public var isSharingRecordings = false
  public private(set) var isExporting = false
  public private(set) var exportItems: [ExportService.ItemProgress] = []
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
  public private(set) var overlays: [ProgramOverlay] = []
  public private(set) var templates: [OverlayTemplate] = []
  public private(set) var activeTemplateID = UUID()

  let converter: PixelConverter
  let index: ArchiveIndex
  let proxyReader: ProxyReader
  let assembler: SegmentAssembler
  let exporter: ExportService
  let retention: RetentionPolicy
  let programEncoder: ProgramEncoder
  let programStreamer: ProgramStreamer
  private var streamErrorGate = StreamErrorGate()

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
  private let overlayStore = OverlayStore()
  private var webControllers: [UUID: WebOverlayController] = [:]
  private var webSnapshots: [UUID: (CGImage, CGSize)] = [:]
  private var overlayImages: [UUID: CGImage] = [:]
  private var retentionTimer: Timer?
  private var testClock: TestClock?
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
    self.programStreamer = ProgramStreamer(telemetry: telemetry, converter: converter)
    self.router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: compositor,
      programEncoder: programEncoder,
      programStreamer: programStreamer,
      clock: clock
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

    pictureInPicture.onStateChange = { [weak self] in
      self?.publishLiveSessionTelemetry()
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

    let manifest = overlayStore.loadManifest()
    apply(manifest)
    reloadOverlayMedia()

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
    pictureInPicture.tearDown()
    router.audioPlayer.stop()
    router.removeAll()
    discovery?.stop()
    for controller in webControllers.values { controller.stop() }
    webControllers.removeAll()
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
    refreshDiscovery()
    pushDisplayNamesToTiles()
  }

  public func forgetCamera(for id: SourceID) {
    guard let camera = boundCamera(for: id) else { return }
    cameras.forget(camera.id)
    cameraRecords = cameras.records
    refreshDiscovery()
    pushDisplayNamesToTiles()
  }

  /// Wipes every remembered camera and tile mapping. Live cameras that still advertise a hardened
  /// id (NearStream TXT or RTSP CNAME) are discovered again as new records.
  public func clearCameraMemory() {
    cameras.clear()
    selectionStore.clear()
    selections = []
    cameraRecords = []
    rowEndpoints = [:]
    if let discovered = discovery?.currentSources, !discovered.isEmpty {
      applyDiscovery(discovered)
    } else {
      cameraRecords = cameras.records
    }
    Task { await syncEnabledSources() }
    statusMessage = "Camera memory cleared"
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

  public var shouldKeepAliveInBackground: Bool {
    BackgroundKeepAlive.shouldStayActive(isRecording: isRecording, isStreaming: isStreaming)
  }

  public func attachProgramPictureInPicture(host: UIView) {
    pictureInPicture.attach(renderer: router.programRenderer, host: host)
  }

  public func handleForeground() {
    isInBackground = false
    syncLiveSessionPresentation()
  }

  public func handleInactive() {
    guard shouldKeepAliveInBackground else { return }
    pictureInPicture.prepare()
    pictureInPicture.startIfPossible()
    publishLiveSessionTelemetry()
  }

  /// Recording or streaming keeps the programme mix playing so iOS does not suspend the process.
  /// Anything else still finalises an in-flight recording (there should not be one) and lets the
  /// system freeze the preview.
  public func handleBackground() async {
    isInBackground = true
    if shouldKeepAliveInBackground {
      router.audioPlayer.start()
      pictureInPicture.startIfPossible()
      publishLiveSessionTelemetry()
      return
    }
    await prepareForSuspension()
    router.audioPlayer.stop()
    pictureInPicture.tearDown()
    publishLiveSessionTelemetry()
  }

  /// Called when the scene goes to the background without a live session. Recording is stopped
  /// rather than paused: the hardware encoder is unavailable to a suspended app, so a recording
  /// that survives suspension only produces a truncated file and a set of sessions nobody closes.
  public func prepareForSuspension() async {
    if isStreaming {
      reportStreamError("Streaming stopped — app moved to the background")
      await stopStreaming()
    }
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

  private func syncLiveSessionPresentation() {
    if shouldKeepAliveInBackground {
      router.audioPlayer.start()
      pictureInPicture.prepare()
      if isInBackground {
        pictureInPicture.startIfPossible()
      } else {
        pictureInPicture.stopOverlay()
      }
    } else if isInBackground {
      router.audioPlayer.stop()
      pictureInPicture.tearDown()
    } else if !router.activePipelines.isEmpty {
      router.audioPlayer.start()
      pictureInPicture.prepare()
    } else {
      router.audioPlayer.stop()
      pictureInPicture.tearDown()
    }
    publishLiveSessionTelemetry()
  }

  private func publishLiveSessionTelemetry() {
    let keepAlive = shouldKeepAliveInBackground
    let playing = router.audioPlayer.isRunning
    let pip = pictureInPicture.isActive
    telemetry.mutate {
      $0.keepAliveInBackground = keepAlive
      $0.programAudioPlaying = playing
      $0.pictureInPictureActive = pip
    }
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
      router.audioPlayer.start()
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
    applyProgramOverlays()
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
    syncLiveSessionPresentation()
  }

  public func toggleStreaming() {
    if isStreaming {
      Task { await stopStreaming() }
    } else {
      startStreaming()
    }
  }

  public func startStreaming() {
    guard !isStreaming else { return }
    streamErrorGate.reset()
    isStreaming = true
    let url = config.streamURL
    let session = config
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.programStreamer.start(urlString: url, config: session) { [weak self] message in
          Task { @MainActor in
            self?.reportStreamError(message)
            await self?.stopStreaming()
          }
        }
      } catch {
        await MainActor.run {
          self.reportStreamError(Self.streamErrorMessage(error))
          self.isStreaming = false
        }
      }
    }
  }

  public func stopStreaming() async {
    guard isStreaming || programStreamer.running else {
      isStreaming = false
      return
    }
    isStreaming = false
    programStreamer.stop()
    streamMegabitsPerSecond = 0
    streamDroppedPackets = 0
    streamErrorGate.reset()
  }

  private func reportStreamError(_ message: String) {
    guard streamErrorGate.shouldPresent(message) else { return }
    statusMessage = message
    telemetry.mutate { $0.dvr.lastError = message }
  }

  private static func streamErrorMessage(_ error: Error) -> String {
    if let parse = error as? RTMPURL.ParseError { return parse.description }
    if let client = error as? RTMPClientError { return client.description }
    if let encoder = error as? ProgramStreamerError { return encoder.description }
    return error.localizedDescription
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
    syncLiveSessionPresentation()
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
    applyProgramOverlays()
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
      applyProgramOverlays()
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
          self?.applyProgramOverlays()
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
    selectProgram(tileIndex: tileIndex)
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
    applyProgramOverlays()
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
      applyProgramOverlays()
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
          self?.applyProgramOverlays()
        }
      }
    )

    do {
      try await pipeline.beginReplay(decoder, offsetSeconds: offsetSeconds)
      statusMessage = nil
      telemetry.mutate { $0.lastReplayError = "" }
      applyProgramOverlays()
    } catch {
      statusMessage = "Holding still — replay failed: \(error)"
      telemetry.mutate { $0.lastReplayError = "\(error)" }
      applyProgramOverlays()
    }
  }

  public func returnToLive(tileIndex: Int) {
    router.pipeline(at: tileIndex)?.returnToLive()
    if router.currentProgramTile == tileIndex {
      router.programRenderer.prepareForLive()
    }
    applyProgramOverlays()
  }

  private static func pngData(_ data: Data) -> Data {
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return data }
    return UIImage(data: data)?.pngData() ?? data
  }

  /// Instant Replay caption burns into Output whenever that camera is replaying. Scrub uses the
  /// same off-live path for operator overlays, but not for the caption.
  private func programSourceIsReplaying() -> Bool {
    guard let index = router.currentProgramTile else { return false }
    let state = telemetry.snapshot.tiles.first { $0.index == index }?.state
    return state == .replaying
  }

  private func programSourceIsOffLive() -> Bool {
    guard let index = router.currentProgramTile else { return false }
    let state = telemetry.snapshot.tiles.first { $0.index == index }?.state
    return state == .replaying || state == .scrubbing
  }

  private func applyProgramOverlays() {
    compositor?.setInstantReplayVisible(programSourceIsReplaying())
    compositor?.setOverlays(composedOverlayItems())
  }

  private var overlayCanvas: CGSize {
    CGSize(
      width: compositor?.width ?? config.programResolution.width,
      height: compositor?.height ?? config.programResolution.height
    )
  }

  private func composedOverlayItems() -> [MetalCompositor.OverlayItem] {
    let canvas = overlayCanvas
    let rects = OverlayLayout.displayRects(
      overlays: overlays,
      canvas: canvas,
      programIsOffLive: programSourceIsOffLive()
    )
    return overlays.compactMap { overlay in
      let rect = rects[overlay.id] ?? .zero
      guard rect.width > 0.5, rect.height > 0.5 else { return nil }
      let image: CGImage?
      switch overlay.kind {
      case .web: image = webSnapshots[overlay.id]?.0
      case .image: image = overlayImages[overlay.id]
      }
      guard let image else { return nil }
      return MetalCompositor.OverlayItem(image: image, origin: rect.origin, size: rect.size)
    }
  }

  private func reloadOverlayMedia() {
    for overlay in overlays {
      switch overlay.kind {
      case .web:
        startWebOverlay(overlay)
      case .image:
        loadOverlayImage(overlay)
      }
    }
    applyProgramOverlays()
  }

  private func startWebOverlay(_ overlay: ProgramOverlay) {
    guard overlay.kind == .web else { return }
    if overlay.url.isEmpty {
      webControllers[overlay.id]?.stop()
      webControllers[overlay.id] = nil
      return
    }
    let controller: WebOverlayController
    if let existing = webControllers[overlay.id] {
      controller = existing
    } else {
      controller = WebOverlayController(size: overlayCanvas)
      let id = overlay.id
      controller.onSnapshot = { [weak self] image, size in
        self?.handleWebSnapshot(id: id, image: image, size: size)
      }
      webControllers[id] = controller
    }
    controller.load(urlString: overlay.url)
  }

  private func loadOverlayImage(_ overlay: ProgramOverlay) {
    let url = overlayStore.imageURL(filename: overlay.imageFilename)
    guard
      let data = try? Data(contentsOf: url),
      let image = UIImage(data: data)?.cgImage
    else { return }
    overlayImages[overlay.id] = image
    if !overlay.hasLaidOut {
      applyInitialLayout(id: overlay.id, native: CGSize(width: image.width, height: image.height))
    }
  }

  private func handleWebSnapshot(id: UUID, image: CGImage?, size: CGSize) {
    if let image, size.width >= 1, size.height >= 1 {
      webSnapshots[id] = (image, size)
      fitWebOverlay(id: id, native: size)
    } else {
      webSnapshots[id] = nil
    }
    applyProgramOverlays()
  }

  /// Web overlays keep their top-left. Display size is natural page size times the user's scale,
  /// so a refresh that grows the page grows the box down and to the right instead of cropping.
  private func fitWebOverlay(id: UUID, native: CGSize) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    let canvas = overlayCanvas
    let firstMeasure = overlays[index].nativeWidth < 1
    overlays[index].nativeWidth = Double(native.width)
    overlays[index].nativeHeight = Double(native.height)
    if !overlays[index].hasLaidOut {
      if overlays[index].placement == .topLeftNative {
        overlays[index].scale = 1
        overlays[index].originX = Double(OverlayLayout.topLeftInset.x / canvas.width)
        overlays[index].originY = Double(OverlayLayout.topLeftInset.y / canvas.height)
      } else {
        overlays[index].scale = OverlayLayout.scaleFittingQuarter(native: native, canvas: canvas)
        let size = CGSize(
          width: native.width * overlays[index].scale,
          height: native.height * overlays[index].scale
        )
        overlays[index].originX = Double((canvas.width - size.width) / 2 / canvas.width)
        overlays[index].originY = Double((canvas.height - size.height) / 2 / canvas.height)
      }
    } else if firstMeasure, overlays[index].width > 0 {
      overlays[index].scale = (overlays[index].width * canvas.width) / max(Double(native.width), 1)
    }
    let size = OverlayLayout.scaledNormalized(
      native: native,
      scale: overlays[index].scale,
      canvas: canvas
    )
    overlays[index].width = size.width
    overlays[index].height = size.height
    overlays[index].hasLaidOut = true
    applyAnchoredChildren(of: id)
    persistActiveTemplate()
  }

  private func syncDisplaySize(at index: Int, canvas: CGSize) {
    let overlay = overlays[index]
    guard overlay.kind == .web, overlay.nativeWidth >= 1 else { return }
    let size = OverlayLayout.scaledNormalized(
      native: CGSize(width: overlay.nativeWidth, height: overlay.nativeHeight),
      scale: overlay.scale,
      canvas: canvas
    )
    overlays[index].width = size.width
    overlays[index].height = size.height
  }

  private func applyInitialLayout(id: UUID, native: CGSize) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    let canvas = overlayCanvas
    let rect = overlays[index].placement == .topLeftNative
      ? OverlayLayout.topLeftNative(native: native, canvas: canvas)
      : OverlayLayout.centerQuarter(native: native, canvas: canvas)
    let normalized = OverlayLayout.normalized(rect, canvas: canvas)
    overlays[index].originX = normalized.originX
    overlays[index].originY = normalized.originY
    overlays[index].width = normalized.width
    overlays[index].height = normalized.height
    overlays[index].hasLaidOut = true
    persistActiveTemplate()
  }

  public func addWebOverlay(url: String, showInRewind: Bool = false) {
    let canvas = overlayCanvas
    let rect = OverlayLayout.centerQuarter(native: CGSize(width: 800, height: 450), canvas: canvas)
    let normalized = OverlayLayout.normalized(rect, canvas: canvas)
    let overlay = ProgramOverlay(
      kind: .web,
      url: url,
      originX: normalized.originX,
      originY: normalized.originY,
      width: normalized.width,
      height: normalized.height,
      placement: .centerQuarter,
      showInRewind: showInRewind
    )
    overlays.append(overlay)
    persistActiveTemplate()
    startWebOverlay(overlay)
    applyProgramOverlays()
  }

  public func addImageOverlay(data: Data, displayName: String, showInRewind: Bool = false) {
    let filename = "\(UUID().uuidString).png"
    do {
      try overlayStore.writeImage(Self.pngData(data), filename: filename)
    } catch {
      statusMessage = "Could not save image: \(error)"
      return
    }
    let canvas = overlayCanvas
    let rect = OverlayLayout.centerQuarter(native: CGSize(width: 800, height: 800), canvas: canvas)
    let normalized = OverlayLayout.normalized(rect, canvas: canvas)
    let overlay = ProgramOverlay(
      kind: .image,
      imageFilename: filename,
      imageDisplayName: displayName,
      originX: normalized.originX,
      originY: normalized.originY,
      width: normalized.width,
      height: normalized.height,
      placement: .centerQuarter,
      showInRewind: showInRewind
    )
    overlays.append(overlay)
    persistActiveTemplate()
    loadOverlayImage(overlay)
    applyProgramOverlays()
  }

  public func replaceOverlayImage(id: UUID, data: Data, displayName: String) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    let filename = "\(UUID().uuidString).png"
    do {
      try overlayStore.writeImage(Self.pngData(data), filename: filename)
    } catch {
      statusMessage = "Could not save image: \(error)"
      return
    }
    overlayStore.removeImage(filename: overlays[index].imageFilename)
    overlays[index].imageFilename = filename
    overlays[index].imageDisplayName = displayName
    overlays[index].hasLaidOut = false
    persistActiveTemplate()
    loadOverlayImage(overlays[index])
    applyProgramOverlays()
  }

  public func setOverlayShowInRewind(id: UUID, showInRewind: Bool) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    overlays[index].showInRewind = showInRewind
    persistActiveTemplate()
    applyProgramOverlays()
  }

  public func overlayPreviewImage(for overlay: ProgramOverlay) -> CGImage? {
    switch overlay.kind {
    case .image:
      return overlayImages[overlay.id]
    case .web:
      return webSnapshots[overlay.id]?.0
    }
  }

  public func updateOverlayURL(id: UUID, url: String) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    overlays[index].url = url
    persistActiveTemplate()
    startWebOverlay(overlays[index])
  }

  public func moveOverlay(
    id: UUID,
    originX: Double,
    originY: Double
  ) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    let dx = originX - overlays[index].originX
    let dy = originY - overlays[index].originY
    overlays[index].originX = originX
    overlays[index].originY = originY
    overlays[index].hasLaidOut = true
    if overlays[index].kind == .web {
      shiftDescendants(of: id, dx: dx, dy: dy)
    }
    applyProgramOverlays()
  }

  public func commitOverlayMove(id: UUID, displayCanvas: CGSize) {
    refreshAttachments(displayCanvas: displayCanvas)
    persistActiveTemplate()
    applyProgramOverlays()
  }

  public func resizeOverlay(
    id: UUID,
    originX: Double,
    originY: Double,
    width: Double,
    height: Double
  ) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    overlays[index].originX = originX
    overlays[index].originY = originY
    overlays[index].width = min(max(width, 0.02), 4)
    overlays[index].height = min(max(height, 0.02), 4)
    overlays[index].hasLaidOut = true
    let canvas = overlayCanvas
    if overlays[index].kind == .web, overlays[index].nativeWidth >= 1 {
      overlays[index].scale = (overlays[index].width * canvas.width) / overlays[index].nativeWidth
      syncDisplaySize(at: index, canvas: canvas)
      applyAnchoredChildren(of: id)
    }
    applyProgramOverlays()
  }

  public func commitOverlayResize(id: UUID, displayCanvas: CGSize) {
    refreshAttachments(displayCanvas: displayCanvas)
    persistActiveTemplate()
  }

  public func removeOverlay(id: UUID) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    let overlay = overlays.remove(at: index)
    for i in overlays.indices where overlays[i].anchorID == id {
      overlays[i].anchorID = nil
      overlays[i].anchorEdge = nil
      overlays[i].anchorGap = 0
    }
    persistActiveTemplate()
    webControllers[id]?.stop()
    webControllers[id] = nil
    webSnapshots[id] = nil
    overlayImages[id] = nil
    if overlay.kind == .image {
      overlayStore.removeImage(filename: overlay.imageFilename)
    }
    applyProgramOverlays()
  }

  public func selectTemplate(id: UUID) {
    persistActiveTemplate()
    guard templates.contains(where: { $0.id == id }) else { return }
    activeTemplateID = id
    overlays = templates.first(where: { $0.id == id })?.overlays ?? []
    persistActiveTemplate()
    stopUnusedOverlayMedia()
    reloadOverlayMedia()
  }

  public func renameTemplate(id: UUID, name: String) {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    persistActiveTemplate()
    guard let index = templates.firstIndex(where: { $0.id == id }) else { return }
    templates[index].name = trimmed
    persistActiveTemplate()
  }

  public func createTemplate(name: String) -> UUID? {
    persistActiveTemplate()
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let template = OverlayTemplate(id: UUID(), name: trimmed)
    templates.append(template)
    activeTemplateID = template.id
    overlays = []
    persistActiveTemplate()
    stopUnusedOverlayMedia()
    reloadOverlayMedia()
    return template.id
  }

  public func duplicateTemplate(from sourceID: UUID, name: String) -> UUID? {
    persistActiveTemplate()
    guard let source = templates.first(where: { $0.id == sourceID }) else { return nil }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let copied = copyOverlays(source.overlays)
    let template = OverlayTemplate(id: UUID(), name: trimmed, overlays: copied)
    templates.append(template)
    activeTemplateID = template.id
    overlays = template.overlays
    persistActiveTemplate()
    stopUnusedOverlayMedia()
    reloadOverlayMedia()
    return template.id
  }

  public func deleteTemplate(id: UUID) {
    persistActiveTemplate()
    guard let index = templates.firstIndex(where: { $0.id == id }) else { return }
    let removed = templates[index]
    for overlay in removed.overlays where overlay.kind == .image {
      overlayStore.removeImage(filename: overlay.imageFilename)
    }
    if templates.count == 1 {
      apply(OverlayManifest.emptyDefault())
    } else {
      templates.remove(at: index)
      if activeTemplateID == id {
        let next = templates[min(index, templates.count - 1)]
        activeTemplateID = next.id
        overlays = next.overlays
      }
    }
    persistActiveTemplate()
    stopUnusedOverlayMedia()
    reloadOverlayMedia()
  }

  public func overlayPreviewUIImage(for overlay: ProgramOverlay) -> UIImage? {
    guard let image = overlayPreviewImage(for: overlay) else { return nil }
    if overlay.kind == .web {
      return Self.topLeftSquare(image)
    }
    return UIImage(cgImage: image)
  }

  private func apply(_ manifest: OverlayManifest) {
    templates = manifest.templates
    activeTemplateID = manifest.activeTemplateID
    overlays = templates.first(where: { $0.id == activeTemplateID })?.overlays ?? []
  }

  private func persistActiveTemplate() {
    if let index = templates.firstIndex(where: { $0.id == activeTemplateID }) {
      templates[index].overlays = overlays
    } else if templates.isEmpty {
      let fallback = OverlayTemplate(
        id: activeTemplateID,
        name: OverlayTemplate.defaultName,
        overlays: overlays
      )
      templates = [ fallback ]
    }
    overlayStore.save(
      OverlayManifest(templates: templates, activeTemplateID: activeTemplateID)
    )
  }

  private func copyOverlays(_ source: [ProgramOverlay]) -> [ProgramOverlay] {
    var idMap: [UUID: UUID] = [:]
    var copies: [ProgramOverlay] = []
    copies.reserveCapacity(source.count)
    for overlay in source {
      let newID = UUID()
      idMap[overlay.id] = newID
      var copy = overlay
      copy.id = newID
      if overlay.kind == .image, !overlay.imageFilename.isEmpty {
        if let filename = try? overlayStore.copyImage(filename: overlay.imageFilename) {
          copy.imageFilename = filename
        }
      }
      copies.append(copy)
    }
    for i in copies.indices {
      if let old = copies[i].anchorID {
        copies[i].anchorID = idMap[old]
      }
    }
    return copies
  }

  private func stopUnusedOverlayMedia() {
    let ids = Set(overlays.map(\.id))
    for id in webControllers.keys where !ids.contains(id) {
      webControllers[id]?.stop()
      webControllers[id] = nil
      webSnapshots[id] = nil
    }
    for id in overlayImages.keys where !ids.contains(id) {
      overlayImages[id] = nil
    }
  }

  private static func topLeftSquare(_ image: CGImage) -> UIImage {
    let crop = OverlayLayout.webThumbnailCrop(
      contentSize: CGSize(width: image.width, height: image.height)
    )
    let renderer = UIGraphicsImageRenderer(size: crop.size)
    return renderer.image { _ in
      UIImage(cgImage: image).draw(at: .zero)
    }
  }

  private func shiftDescendants(of parentID: UUID, dx: Double, dy: Double) {
    for i in overlays.indices where overlays[i].anchorID == parentID {
      overlays[i].originX += dx
      overlays[i].originY += dy
      shiftDescendants(of: overlays[i].id, dx: dx, dy: dy)
    }
  }

  private func applyAnchoredChildren(of parentID: UUID) {
    let canvas = overlayCanvas
    guard let parent = overlays.first(where: { $0.id == parentID }) else { return }
    let parentRect = OverlayLayout.pixelRect(parent, canvas: canvas)
    for i in overlays.indices {
      guard overlays[i].anchorID == parentID, let edge = overlays[i].anchorEdge else { continue }
      let childRect = OverlayLayout.pixelRect(overlays[i], canvas: canvas)
      let origin = OverlayLayout.anchoredOrigin(
        parent: parentRect,
        child: childRect,
        edge: edge,
        gap: CGFloat(overlays[i].anchorGap)
      )
      overlays[i].originX = Double(origin.x / max(canvas.width, 1))
      overlays[i].originY = Double(origin.y / max(canvas.height, 1))
      applyAnchoredChildren(of: overlays[i].id)
    }
  }

  /// Nearby overlays (within 20 display pixels of a web view's right or bottom edge) become
  /// relative to that page so a later refresh can push them.
  private func refreshAttachments(displayCanvas: CGSize) {
    guard displayCanvas.width >= 1, displayCanvas.height >= 1 else { return }
    let output = overlayCanvas
    let gapScale = output.width / displayCanvas.width
    for i in overlays.indices {
      overlays[i].anchorID = nil
      overlays[i].anchorEdge = nil
      overlays[i].anchorGap = 0
    }
    for i in overlays.indices {
      let child = overlays[i]
      let childRect = OverlayLayout.pixelRect(child, canvas: displayCanvas)
      var best: (id: UUID, edge: OverlayAnchorEdge, gap: CGFloat, distance: CGFloat)?
      for parent in overlays where parent.kind == .web && parent.id != child.id {
        if isDescendant(parent.id, of: child.id) { continue }
        let parentRect = OverlayLayout.pixelRect(parent, canvas: displayCanvas)
        guard let found = OverlayLayout.attachment(parent: parentRect, child: childRect) else {
          continue
        }
        let distance = abs(found.gap)
        if best == nil || distance < best!.distance {
          best = (parent.id, found.edge, found.gap, distance)
        }
      }
      if let best {
        overlays[i].anchorID = best.id
        overlays[i].anchorEdge = best.edge
        overlays[i].anchorGap = Double(best.gap * gapScale)
      }
    }
  }

  private func isDescendant(_ id: UUID, of ancestor: UUID) -> Bool {
    var currentID: UUID? = id
    var hops = 0
    while let next = currentID, hops < 16 {
      if next == ancestor { return true }
      currentID = overlays.first(where: { $0.id == next })?.anchorID
      hops += 1
    }
    return false
  }

  /// The scrubbable depth for a tile, used to scale the drag gesture.
  ///
  /// Measured from proxy stills of the current recording, not from completed archive segments.
  /// Segments close every `segmentSeconds` (3 by default) and the previous gate required the last
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
    config = session
    applyDisplayLatencyCap()
    if wantsSimulated != sessionIsSimulated {
      Task { await applySourceProfile(SourceProfile.forSimulatedCameras(wantsSimulated)) }
    }
  }

  /// Launch arguments overlay the running session and are forgotten when the process exits.
  /// Writing them back is how a test flag became a saved setting, so they never touch disk.
  private static func applying(_ launch: LaunchConfiguration, to config: AppConfig) -> AppConfig {
    var config = config
    if let seconds = launch.segmentSeconds { config.segmentSeconds = seconds }
    if let codec = launch.programCodec { config.programCodec = codec }
    if let hud = launch.debugHUD { config.showDebugHUD = hud }
    if let url = launch.streamURL { config.streamURL = url }
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
    guard !isExporting else { return }
    var items: [ExportService.ItemProgress] = []
    if includeProgram && recording.programFilename != nil {
      items.append(ExportService.ItemProgress(id: "program", name: "Primary output", fraction: 0))
    }
    for camera in cameras {
      items.append(ExportService.ItemProgress(id: camera.0.rawValue, name: camera.1, fraction: 0))
    }
    exportItems = items
    isExporting = true

    let exporter = self.exporter
    let cameraList = cameras.map { (sourceID: $0.0, name: $0.1) }
    Task { [weak self] in
      do {
        let urls = try await Task.detached(priority: .userInitiated) {
          try exporter.exportRecording(
            recording,
            cameras: cameraList,
            includeProgram: includeProgram,
            progress: { item in
              Task { @MainActor in
                guard let self else { return }
                if let index = self.exportItems.firstIndex(where: { $0.id == item.id }) {
                  self.exportItems[index].fraction = item.fraction
                } else {
                  self.exportItems.append(item)
                }
              }
            }
          )
        }.value
        await MainActor.run {
          guard let self else { return }
          self.isExporting = false
          guard !urls.isEmpty else {
            self.statusMessage = "Nothing to export for that recording"
            return
          }
          self.lastRecordingShare = urls
          self.isSharingRecordings = true
        }
      } catch {
        await MainActor.run {
          self?.isExporting = false
          self?.statusMessage = "Export failed: \(error)"
        }
      }
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
    let overlayStatus = webControllers.values.map(\.status).joined(separator: " ")
    let composedFrames = compositor?.frameCount ?? 0
    let discoveryStatus = discovery?.diagnostic ?? ""
    let displayLatency = cameras.playout.programMilliseconds
    telemetry.mutate {
      $0.statusMessage = status
      $0.sources = summaries
      $0.overlay = overlayStatus
      $0.composedFrames = composedFrames
      $0.audioMixContributors = mix.contributors
      $0.audioMixSeconds = (mix.emittedSeconds * 10).rounded() / 10
      $0.cpuPercent = (cpu * 10).rounded() / 10
      $0.cpuCores = ProcessLoad.coreCount
      $0.availableMemoryMB = ProcessLoad.availableMemoryMB()
      $0.physFootprintMB = ProcessLoad.physFootprintMB()
      $0.discoveryStatus = discoveryStatus
      $0.displayLatencyMilliseconds = displayLatency
      $0.programAudioPlaying = self.router.audioPlayer.isRunning
      $0.keepAliveInBackground = self.shouldKeepAliveInBackground
      $0.pictureInPictureActive = self.pictureInPicture.isActive
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
    if isStreaming {
      let stream = programStreamer.metrics
      streamMegabitsPerSecond = stream.megabitsPerSecond
      streamDroppedPackets = stream.droppedPackets
    }
    snapshot = telemetry.snapshot
    applyProgramOverlays()
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
    case let .stream(on):
      if on { startStreaming() } else { Task { await stopStreaming() } }
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
