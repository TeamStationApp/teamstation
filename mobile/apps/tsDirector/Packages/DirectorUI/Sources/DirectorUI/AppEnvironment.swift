import AVFoundation
import Foundation
import Observation
import os
// Only the level enum: CameramanCore also has a `ProcessLoad`, which would collide with DirectorPipeline's.
import enum CameramanCore.ThermalBadgeLevel
import CameramanRemote
import DirectorRTSP
import DirectorCore
import DirectorDVR
import DirectorMedia
import DirectorPipeline
import DirectorRTMP
import DirectorSources
import DirectorTestHarness
import DirectorLink
import DistributorWire
import EventControl
import TeamStationKit
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

/// Last `played` value from the replay decoder, because `onFinish` runs after the player has
/// already been torn down.
private final class PlayedSeconds: @unchecked Sendable {
  private let lock = NSLock()
  private var value: TimeInterval = 0

  func store(_ played: TimeInterval) {
    lock.lock()
    value = played
    lock.unlock()
  }

  func load() -> TimeInterval {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/// Holds the running decoder so `onNeedsMoreFiles` can append without a retain cycle.
private final class ReplayHolder: @unchecked Sendable {
  weak var decoder: ReplayDecoder?
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

  public enum Sheet: Identifiable, Sendable, Equatable {
    case settings, perfHarness, cameras, recordings
    /// Cameraman's own operating screen for the phone on a tile, full screen over the grid.
    case cameraControl(sourceIndex: Int)
    /// Director's own zoom for a camera that is not a controllable Cameraman.
    case digitalZoom(sourceIndex: Int)

    public var id: String {
      switch self {
      case .settings: "settings"
      case .perfHarness: "perfHarness"
      case .cameras: "cameras"
      case .recordings: "recordings"
      case let .cameraControl(sourceIndex): "cameraControl-\(sourceIndex)"
      case let .digitalZoom(sourceIndex): "digitalZoom-\(sourceIndex)"
      }
    }
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
  /// The TeamStation account this Director is signed in to, and the game it is
  /// pointed at. Built once, from the configured address; changing that address
  /// in Settings signs the app out, because a token is only good on the server
  /// that issued it.
  /// `@ObservationIgnored` because the account is itself observable: what the
  /// screens watch is the state inside it, and the reference never changes.
  @ObservationIgnored
  public private(set) lazy var teamStation: TeamStationAccount = makeAccount()
  /// The rules for the chosen event: which takes it files, and when it is
  /// claimed. Every decision is in there, where it is tested.
  @ObservationIgnored
  public private(set) lazy var eventCoordinator = EventCoordinator(
    events: teamStation,
    linker: index,
    currentTake: { [weak self] in self?.activeRecordingID },
    cameraName: { [weak self] in self?.cameraNameForClaim ?? "" },
    selectionChanged: { [weak self] in self?.eventControl.selectionChanged() }
  )
  /// "Set event on nearby devices": keeps nearby devices of the same account on the event chosen
  /// here. Reads the account and the chosen event; nothing of Director's own recording, stream or
  /// overlays reads it.
  @ObservationIgnored
  public private(set) lazy var eventControl = EventControlCoordinator(
    account: teamStation,
    instanceId: EventControlInstanceID.persisted(
      in: .standard,
      key: EventControlCoordinator.instanceIdKey
    ),
    keyStore: EventControlKeyStore(service: EventControlCoordinator.keyStoreService)
  )
  /// How far TeamStation's clock is from this iPad's steady wall clock: measured at sign-in, then
  /// every minute while a take linked to an event records or streams, each measurement kept in the
  /// index, where a take reads its own (`RecordingSummary.serverClockOffsetMs`) for its uploads.
  /// Asked of the server Director is built for, with no sign-in.
  @ObservationIgnored
  public private(set) lazy var serverClock: ServerClock = {
    let index = self.index
    let clock = self.clock
    return ServerClock(
      client: TeamStationClient(baseURL: AppServer.url),
      now: { clock.now.date },
      onSample: { sample in
        try? index.insertServerClockSample(ServerClockRecord(
          wall: WallClock(date: sample.wall),
          offsetMs: sample.offsetMs,
          rttMs: sample.rttMs
        ))
      }
    )
  }()
  /// The camera name the next claim sends.
  ///
  /// Copied from `config.cameraName` at launch and again when Settings opens.
  /// The Camera name field writes it on each change, so picking an event
  /// before SAVE still sends the name that was typed.
  public var cameraNameForClaim = ""
  /// Keeps each Scoreboard content item's page on the sample, the chosen
  /// event's board, or nothing, with this environment running the pages.
  @ObservationIgnored
  private lazy var scoreboardDriver = ScoreboardOverlayDriver(host: self)
  public private(set) var snapshot = TelemetrySnapshot()
  public private(set) var isRecording = false {
    didSet {
      guard isRecording != oldValue else { return }
      // A take starting or stopping changes what TS Distributor may ask the iPad to stitch, and the
      // recordings it lists.
      distributorEvents.publish(.recordingStateChanged(isRecording: isRecording))
      distributorEvents.publish(.recordingsChanged)
      updateScoreboards()
      holdProgrammeSound()
      followServerClock()
    }
  }
  /// TS Distributor is attached by cable and talking to this Director.
  public private(set) var isMacConnected = false
  /// TS Distributor's export lease: while it is held, recording and streaming wait, and it is not
  /// granted while either is on. Dropped when the Mac hands it back, goes away or stops renewing it.
  private var exportLease = ExportLease()
  private var exportLeaseWatch: Task<Void, Never>?
  /// The export TS Distributor is running, if any.
  public var distributorExport: UUID? { exportLease.id }
  /// Whether the operator wants the programme streaming. `isStreaming` says whether it is going out
  /// right now; this says whether it should be, which is what tells a drop from a Stop.
  private var streamWanted = false
  /// Set as the operator starts the stream, until TeamStation has been told when its first picture
  /// was captured; see `EventCoordinator.liveStarted`.
  private var liveStartWanted = false

  public private(set) var isStreaming = false {
    didSet {
      guard isStreaming != oldValue else { return }
      distributorEvents.publish(.streamingStateChanged(isStreaming: isStreaming))
      updateScoreboards()
      holdProgrammeSound()
      followServerClock()
    }
  }

  /// Keeps the programme's two mixes counting while a stream is wanted or a take is recording, so
  /// both sound tracks run from go-live, silent until a camera speaks. A dropped stream that is
  /// being redialled still holds them: its sound must carry on from the same counter.
  private func holdProgrammeSound() {
    router.setProgrammeSoundLive(isRecording || isStreaming || streamWanted)
  }
  public private(set) var streamMegabitsPerSecond = 0.0
  public private(set) var streamDroppedPackets: UInt64 = 0
  public let pictureInPicture = ProgramPictureInPicture()
  private var isInBackground = false
  public private(set) var statusMessage: String? {
    didSet {
      // Stamped when the words change, not on every assignment. Several writers re-post the same
      // sentence on a timer — the retention sweep repeats "Low storage" every sixty seconds for
      // as long as the disk is tight — and re-stamping there would leave the toast reading a
      // minute old however long the condition had been true, which is the opposite of what the
      // operator reads a timestamp for.
      guard statusMessage != oldValue else { return }
      statusMessagePostedAt = statusMessage == nil ? nil : Date()
    }
  }
  /// When `statusMessage` was posted, for the toast's timestamp. Nil whenever the message is.
  public private(set) var statusMessagePostedAt: Date?

  public func dismissStatusMessage() {
    statusMessage = nil
  }

  /// Force the header pill to `state` for `duration`, then return to the live thermal reading.
  public func previewThermal(
    _ state: ProcessInfo.ThermalState,
    duration: Duration = .seconds(10)
  ) {
    thermalPreviewTask?.cancel()
    thermalPreview = state
    thermalPreviewTask = Task { @MainActor in
      try? await Task.sleep(for: duration)
      guard !Task.isCancelled else { return }
      thermalPreview = nil
    }
  }

  /// What the header pill shows: a Settings preview if one is running, otherwise telemetry.
  public var displayedThermalLevel: ThermalBadgeLevel {
    if let thermalPreview {
      return ThermalBadgeLevel(process: thermalPreview)
    }
    return ThermalBadgeLevel(telemetryName: snapshot.thermalState)
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
  /// The model behind the open Cameraman control screen. Created when the screen opens, stopped
  /// when it closes; nothing is retained across opens.
  public private(set) var activeCameraControl: RemoteCameraControl?
  @ObservationIgnored private var activeCameraControlIndex: Int?
  /// One slow poller per controllable Cameraman on the grid, feeding the tile's thermal and
  /// battery pills. Keyed by identity so a layout swap keeps the right phone on the right tile.
  @ObservationIgnored private var cameraTelemetryPollers: [SourceID: CameraTelemetryPoller] = [:]
  /// Settings Test Thermal Visuals. Header-only; HUD `thermal=` stays the real ProcessInfo name.
  public private(set) var thermalPreview: ProcessInfo.ThermalState?
  private var thermalPreviewTask: Task<Void, Never>?
  /// Text overlay currently being authored on the content canvas.
  public var editingTextOverlayID: UUID?
  /// Which discovery this session is running. Settings can change it without a relaunch.
  private var sourceProfile: SourceProfile

  // MARK: - Machinery

  public let clock: DirectorClock
  public let telemetry: PipelineTelemetry
  public let router: TileRouter
  public private(set) var overlays: [ProgramOverlay] = []
  public private(set) var templates: [OverlayTemplate] = []
  public private(set) var activeTemplateID = UUID()
  public private(set) var editingTemplateID: UUID?
  public private(set) var remoteTemplates: [RemoteControlTemplate] = []
  public private(set) var activeRemoteTemplateID = UUID()
  public private(set) var editingRemoteTemplateID: UUID?
  /// Editor capture target. Nil means pad presses fire production actions.
  public var capturingRemoteAction: RemoteAction?

  let converter: PixelConverter
  let index: ArchiveIndex
  let proxyReader: ProxyReader
  let assembler: SegmentAssembler
  let exporter: ExportService
  let retention: RetentionPolicy
  let programEncoder: ProgramEncoder
  let programStreamer: ProgramStreamer
  /// The programme half of a take: its row, the master, resume as the next part, and the live
  /// session's heartbeat. See `RecordingSession`.
  let programmeRecording: RecordingSession
  /// Keeps the stream on the air: dials, redials with backoff, and stops on an ended stream. See
  /// `StreamSessionController`.
  @ObservationIgnored
  public private(set) lazy var streamSession: StreamSessionController = makeStreamSession()
  /// The settings and destination of the dial in progress, taken as it starts, as the dial always
  /// has: Settings saved mid-dial apply from the next one.
  private var dialConfig = AppConfig.default
  private var streamErrorGate = StreamErrorGate()
  /// Wi-Fi's received bytes, extended past the interface's 32-bit wrap and folded into a rate.
  /// What an NDI tile shows as its throughput, less the RTSP tiles' own counts.
  private var wifiReceivedBytes = WrappingByteCounter()
  private var wifiReceiveRate = CounterRateTracker()

  private let compositor: MetalCompositor?
  /// Builds the live-camera discovery. Injected because the transport lives in its own module and
  /// this one is written against `SourceDiscovery` alone.
  private let discoveryFactory: (@Sendable (SourceKind) -> SourceDiscovery?)?
  private let selectionStore: SourceSelectionStore
  /// Audio decisions kept under the camera's own identifier rather than under the row's, so a
  /// camera that comes back as a new row does not come back in the mix. See `SourceAudioRules`.
  private let audioStore: SourceAudioStore
  private var audioSettings: [String: SourceAudioSetting] = [:]
  /// The named-camera cache, shared with discovery so both agree on which camera is which.
  public let cameras: CameraRegistry
  private let configStore: ConfigStore
  /// What an export encodes a take with when the take has no encoding of its own: this session's
  /// settings as they are now. Behind a lock because exports read it off the main actor.
  private let exportFallbackEncoding: OSAllocatedUnfairLock<TakeEncoding>
  private let stateDumper = StateDumper()
  /// The take's once-a-second telemetry, beside its programme master.
  private let takeTelemetry = TakeTelemetryLog(directory: DirectorPaths.program)
  private var controlServer: ControlServer?
  /// TS Distributor's way in: a loopback server the Mac reaches over the cable.
  private var linkServer: LinkServer?
  /// What TS Distributor hears on its event stream; the app publishes its own changes here.
  private let distributorEvents = EventHub()
  /// One per launch, so `Hello.sessionID` changes only when the Director restarts; the listener
  /// in front of it is replaced every time the app comes back to the foreground.
  @ObservationIgnored
  private lazy var distributorService: DistributorService = {
    let roots = FileRoots(.standard)
    return DistributorService(
      backend: DistributorLinkBackend(environment: self, index: index, exporter: exporter, roots: roots),
      roots: roots,
      settings: DistributorSettingsStore(),
      events: distributorEvents
    )
  }()

  private var discovery: SourceDiscovery?
  private var writers: [SourceID: SegmentWriter] = [:]
  /// Format-change and late-audio reopens of one camera, so two packets do not stack writers.
  private var reopeningArchives: Set<SourceID> = []
  private var proxies: [SourceID: ProxyStore] = [:]
  private var recordingID: Int64? { programmeRecording.recordingID }
  private var recordingStartedAt: WallClock? { programmeRecording.startedAt }
  private var pollTimer: Timer?
  /// SwiftUI is fed a snapshot at most once a second, plus immediately on chrome changes
  /// (live/replay, program cut, record/stream). The 5 Hz poll still writes `telemetry` so
  /// `/dump-state` stays fresh without rebuilding the grid DisplayList 5 times a second.
  /// While a tile is replaying or scrubbing, both the poll and the UI copy run at 20 Hz so
  /// the yellow offset pill can tick in tenths — the 5 Hz poll alone skipped ~0.2 s.
  private var lastPublishedUIAt: TimeInterval = 0
  private var pollInterval: TimeInterval = 0
  private static let livePollInterval: TimeInterval = 0.2
  private static let replayPollInterval: TimeInterval = 0.05
  private static let liveUIPublishInterval: TimeInterval = 1
  private static let replayUIPublishInterval: TimeInterval = 0.05
  /// Width of one small source tile, used so Output scrub (if added) shares the 60s-per-width rate.
  public var smallTileWidth: Double = 300
  /// Output's corner and the visual order of Source 1…5. Independent of which camera occupies a
  /// source.
  public private(set) var sourceLayout = SourceLayout.default
  /// Source currently being dragged to a new slot, if any. Scrub and program-tap stand down.
  public var draggingSourceIndex: Int?
  /// Output is being dragged to another corner. Its replay and return-to-live buttons stand down.
  public var isDraggingOutput = false
  /// Wall time until which a lift after a drag must not act as a tap: cutting the dragged source
  /// to Output, or pressing a button on Output after moving it.
  public var ignoreProgramTapUntil: TimeInterval = 0
  private let layoutStore: SourceLayoutStore
  private let programSourceStore: ProgramSourceStore
  /// Last camera put on Output, including the last one enabled in the picker.
  private var preferredProgramSourceID: SourceID?
  private let overlayStore = OverlayStore()
  public let remoteInput = RemoteInputSession()
  private let remoteStore = RemoteControlStore()
  private var webControllers: [UUID: WebOverlayController] = [:]
  private var webSnapshots: [UUID: (CGImage, CGSize)] = [:]
  /// Page size that disagrees with the saved one, held until it proves it is not a transient.
  private var pendingWebNative: [UUID: OverlayLayout.PendingWebNative] = [:]
  private var overlayImages: [UUID: CGImage] = [:]
  private var retentionTimer: Timer?
  @ObservationIgnored private var retentionSweepInFlight = false
  /// The grid last written to the open take, so an unchanged one is not written again.
  private var lastGridSnapshot: Data?
  private var testClock: TestClock?
  private var announcedCameraStatus: [SourceID: String] = [:]
  /// Picture for a preview opened without enabling the camera. A live tile uses its own renderer.
  let peekRenderer = TileRenderer()
  /// Camera whose preview modal is open. Nil when the modal is closed.
  public private(set) var peekID: SourceID?
  /// Why the modal has no picture. Nil while a renderer is feeding it.
  public private(set) var peekStatus: String?
  private var peekMode: SourcePeekTarget = .unavailable
  private var peekSource: FrameSource?
  private var peekAddress: String?
  /// The camera whose tile is about to start because VIDEO was turned on with the modal open.
  /// Holds the modal off a second connection until that pipeline exists.
  private var peekPipelineHandoffID: SourceID?
  private var peekStartError: String?
  private static let peekConnecting = "Connecting…"
  private static let peekUnavailable = "This camera is not available"

  // MARK: - Lifecycle

  public init(
    launch: LaunchConfiguration = .resolve(),
    cameras: CameraRegistry? = nil,
    discoveryFactory: (@Sendable (SourceKind) -> SourceDiscovery?)? = nil
  ) {
    self.launch = launch
    self.discoveryFactory = discoveryFactory

    let testClock = launch.useTestClock ? TestClock() : nil
    self.testClock = testClock
    self.clock = testClock ?? SystemClock()

    self.configStore = ConfigStore()
    let persisted = configStore.load()
    self.persistedConfig = persisted
    self.cameraNameForClaim = persisted.cameraName
    let session = Self.applying(launch, to: persisted)
    self.config = session
    SubnetScanner.setOverrideSubnets(networkAddresses: session.activeScanSubnets)
    self.sourceProfile = Self.resolveSourceProfile(launch: launch, config: session)

    self.selectionStore = SourceSelectionStore(store: configStore)
    self.audioStore = SourceAudioStore()
    self.layoutStore = SourceLayoutStore(store: configStore)
    self.programSourceStore = ProgramSourceStore(store: configStore)
    // The app target passes the same registry it gave to discovery; anything without a transport
    // gets its own, which is empty and harmless.
    let registry = cameras ?? CameraRegistry(store: CameraRecordStore(store: configStore))
    // Never past D, cap on or off, and before any camera is seeded from a saved hold.
    registry.playout.setCap(milliseconds: TileRouter.playoutCapMilliseconds(
      capEnabled: session.displayLatencyCapEnabled,
      capMilliseconds: session.displayLatencyCapMilliseconds
    ))
    // The delay line's cap above bounds how much latency is *added* deliberately. These bound how
    // old a picture may be and still be worth showing, or still be worth keeping — which nothing
    // enforced before, on either transport.

    self.cameras = registry
    self.telemetry = PipelineTelemetry(clock: clock)
    self.converter = PixelConverter()
    self.compositor = MetalCompositor(
      width: session.programResolution.width,
      height: session.programResolution.height
    )
    self.programEncoder = ProgramEncoder(telemetry: telemetry, converter: converter, config: session, clock: clock)
    self.programStreamer = ProgramStreamer(telemetry: telemetry, converter: converter, clock: clock)
    self.router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: compositor,
      programEncoder: programEncoder,
      programStreamer: programStreamer,
      clock: clock
    )
    // Applied here as well as on every settings change: the delay line's cap is set above during
    // construction, and a frame gate that only took effect after the operator next opened Settings
    // would be off for the whole of the first session.
    self.router.setLatencyCaps(FrameLatencyGate.Caps(config: session))
    // And D, which the delay line's cap above was set to: a saved cap other than the default would
    // otherwise hold pictures past a D still at its default until Settings next changed.
    self.router.setLiveSoundDelay(seconds: TileRouter.liveSoundDelaySeconds(
      capEnabled: session.displayLatencyCapEnabled,
      capMilliseconds: session.displayLatencyCapMilliseconds
    ))
    // The programme clock's rates until a take or a stream says otherwise.
    self.router.setRecordingRate(session.programFrameRate)
    self.router.setStreamRate(session.streamFrameRate)

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
    let fallbackEncoding = OSAllocatedUnfairLock(initialState: session.takeEncoding)
    self.exportFallbackEncoding = fallbackEncoding
    self.exporter = ExportService(index: index, fallbackEncoding: { fallbackEncoding.withLock { $0 } })
    self.retention = RetentionPolicy(index: index)
    // The take's anchors and each part's sound check go onto the take's row from here; see
    // `RecordingSession`. The programme clock takes the master's rate from it too.
    let router = self.router
    self.programmeRecording = RecordingSession(
      index: index,
      encoder: programEncoder,
      clock: clock,
      setRecordingRate: { router.setRecordingRate($0) }
    )

    telemetry.mutate { [sourceProfile] snapshot in
      snapshot.sourceProfile = sourceProfile.rawValue
    }

    pictureInPicture.onStateChange = { [weak self] in
      self?.publishLiveSessionTelemetry()
    }

    // Every stream frame's wall-clock SEI is put on TeamStation's clock by the offset last measured.
    // The clock itself, not `self`: it is read on the encoder's thread, which must not reach back
    // into anything main-actor isolated, and `ServerClock` is safe to read from any.
    let serverClock = self.serverClock
    programStreamer.setServerClockOffset { serverClock.offsetMs }
  }

  /// Called once from the app's `task` modifier.
  public func bootstrap() async {
    if launch.isUITest {
      UIApplication.shared.isIdleTimerDisabled = true
      UIView.setAnimationsEnabled(false)
    }
    if launch.clearState {
      selectionStore.clear()
      audioStore.clear()
      layoutStore.clear()
      programSourceStore.clear()
      cameras.clear()
      telemetry.reset()
    }
    audioSettings = audioStore.load()
    let restoredSelections = SourceSelectionRules.normalizingLinks(selectionStore.load())
    // The list first, because an iPad already in use has every audio decision the operator has ever
    // made in it and nothing in the audio store yet; then the store over the top, which is what
    // makes the decisions outlive the rows they were made on.
    let known = audioSettings
    SourceAudioRules.seeding(from: restoredSelections, into: &audioSettings, key: audioKey(for:))
    if audioSettings != known { audioStore.save(audioSettings) }
    selections = SourceAudioRules.applying(audioSettings, to: restoredSelections, key: audioKey(for:))
    sourceLayout = layoutStore.load()
    preferredProgramSourceID = programSourceStore.load()
    cameraRecords = cameras.records

    // A mid-segment kill leaves index rows describing files that were never written. Cleaning
    // up before anything reads the timeline is what makes "relaunch after a crash" safe. Only a
    // take still open when the app died can have been cut off, so only those are checked here;
    // the whole archive waits for `reconcileArchiveInBackground`, because stat-ing every segment
    // on this path held the first screen past the launch watchdog.
    let openTakes = (try? index.openRecordingIDs()) ?? []
    if let result = try? index.reconcile(recordings: openTakes), result.removed > 0 {
      statusMessage = "Recovered index: dropped \(result.removed) missing segment(s)"
    }
    // What the app was doing when it stopped running, and whether it was long enough ago to
    // matter. Read before anything is closed and before any camera starts: a take is picked up by
    // restoring the state that says one is rolling, after which the ordinary camera path attaches
    // a writer to each camera as it arrives.
    //
    // `clearState` abandons instead. It is how a test flow gets a clean device, and a flow that
    // died mid-take must not leak a live recording into the next one.
    let resume = launch.clearState
      ? nil
      : try? LiveSessionResume.plan(
        index: index, now: clock.now, limit: config.resumeDowntimeLimitSeconds
      )

    // After reconcile, so an interrupted take is closed at the end of media that survives on
    // disk rather than at a segment row whose file was never written. The take being resumed is
    // the one row this must not touch.
    if let closed = try? index.closeAbandonedRecordings(except: resume?.liveRecordingID),
      closed > 0 {
      statusMessage = "Closed \(closed) interrupted recording(s)"
    }
    applyResumedRecording(resume)

    let manifest = overlayStore.loadManifest()
    apply(manifest)
    reloadOverlayMedia()
    watchChosenEvent()
    eventControl.start(enabled: config.eventControlEnabled)
    eventControl.monitorNetwork()
    watchAccountForEventControl()
    watchSignInForServerClock()
    apply(remoteStore.loadManifest())
    remoteInput.onDown = { [weak self] id, pressed in
      self?.handleRemoteDown(id, pressed: pressed)
    }
    remoteInput.start()

    startDiscovery()
    // Before the first poll reads it: telemetry and Settings show the cached figure only.
    FreeDiskSpace.shared.startRefreshing()
    startPolling()
    startControlServer()
    startLinkServer()
    ensureProductionReady()
    await syncEnabledSources()
    // After the cameras, because the stream carries the programme composite and there is nothing
    // to send until at least one of them is up.
    applyResumedStream(resume)
    if launch.autoRecord {
      startRecording()
    } else if !isRecording {
      openCameras()
    }
    reconcileArchiveInBackground()
  }

  /// The whole-archive check, off the launch path. A file removed outside the app from a take that
  /// closed normally still loses its row; checking tens of thousands of them just no longer holds
  /// the first screen.
  private func reconcileArchiveInBackground() {
    let index = self.index
    Task.detached(priority: .utility) { [weak self] in
      guard let result = try? index.reconcile(), result.removed > 0 else { return }
      await MainActor.run { [weak self] in
        self?.statusMessage = "Recovered index: dropped \(result.removed) missing segment(s)"
      }
    }
  }

  /// Puts a take that was still rolling back the way it was, before any camera starts.
  ///
  /// Order is the whole feature. `startSource` already gives a camera an archive writer when the
  /// app believes it is recording, and `SegmentWriter.prepare` already continues that camera's
  /// segment numbering, so restoring the state here means every camera re-arms as it appears —
  /// at launch, or minutes later when it is plugged back in — with no further code.
  private func applyResumedRecording(_ resume: LiveSessionResume?) {
    guard let resume else { return }
    let limit = config.resumeDowntimeLimitSeconds
    guard case let .resume(recording, _) = resume.outcome else {
      // Too long ago. The take has just been closed at its last media with the rest, and the row
      // that said it was live has to go with it or the next launch would try again.
      try? index.closeLiveSession()
      statusMessage = resume.banner(limit: limit)
      return
    }
    guard let take = recording else { return }

    // The grid as it was, over the top of whatever the stores hold now. An operator who
    // reconfigured between the crash and the relaunch reconfigured a take that had already ended
    // as far as they knew; this one keeps the cameras it was actually recording.
    if let data = take.selections,
      let restored = try? JSONDecoder().decode([SourceSelection].self, from: data),
      !restored.isEmpty
    {
      // Which cameras and which tiles, but not the mix: the take's snapshot is as old as the take,
      // and an operator who muted a camera an hour into it — or after it — meant that and not the
      // grid it was recording with.
      selections = SourceAudioRules.applying(
        audioSettings,
        to: SourceSelectionRules.normalizingLinks(restored),
        key: audioKey(for:)
      )
      selectionStore.save(selections)
      // Already what the take has on record, so the first discovery sweep after this does not
      // write it straight back — unless the mix above corrected it, which the take should have.
      let corrected = try? JSONEncoder().encode(selections)
      lastGridSnapshot = corrected == data ? data : nil
    }
    if let source = take.programSource {
      preferredProgramSourceID = source
      programSourceStore.save(source)
    }

    // A new part of the same programme file family, with the take's own programme settings, listed
    // on the take's row as it opens. Losing it is not losing the take: the per-camera archives are
    // the part of a game that cannot be made again.
    programmeRecording.adopt(take)
    isRecording = true
    var resumeCount: Int?
    do {
      resumeCount = try programmeRecording.resumeProgramme(
        take,
        at: clock.now,
        settings: RecordingSettings(config: config)
      )
    } catch {
      resumeCount = (try? index.recordings().first { $0.id == take.recordingID })?.resumeCount
      let message = "Program output unavailable after resume: \(error)"
      statusMessage = message
      telemetry.mutate { $0.dvr.lastError = message }
    }

    // The segment each camera was part-way through when the app died was never closed, so it has
    // no row and no movie header. Reconcile reports those as orphans and leaves them; for this
    // take they are unreadable files that would sit on the device forever.
    discardUnreadableOrphans(ofRecording: take.recordingID)

    telemetry.mutate {
      $0.dvr.isRecording = true
      $0.dvr.recordingStartedAt = take.startedAt.seconds
      $0.dvr.resumeCount = UInt64(max(0, resumeCount ?? 1))
      $0.dvr.lastDowntimeSeconds = resume.downtime
    }
    beginLiveSession(recording: take.recordingID)
    startRetentionSweeps()
    syncLiveSessionPresentation()
    statusMessage = resume.banner(limit: limit)
  }

  /// Re-dials the stream if one was up. A stream that had already failed is not one: a transport
  /// failure stops streaming outright, so by the time the app died the session no longer said it
  /// was streaming, and the operator would have seen the same thing.
  private func applyResumedStream(_ resume: LiveSessionResume?) {
    guard let resume, case let .resume(_, streaming) = resume.outcome, streaming else { return }
    guard !streamDestinationURL.isEmpty else {
      reportStreamError("Stream not resumed — no destination configured")
      // And stop saying it was streaming, or every launch from here on tries again and fails the
      // same way.
      endLiveSession(streaming: true)
      return
    }
    telemetry.mutate { $0.dvr.resumedStream = true }
    // A redial of the stream it had, never a request for a new one: a stream that was ended while
    // the app was away stays ended.
    startStreaming(reason: .redial)
  }

  /// Deletes this take's segment files that were never finished and never indexed.
  ///
  /// One per camera at most: the file being written when the process died. It has no movie header,
  /// so nothing can read it, and `reconcile` only reports it. Anything a reader can open is left
  /// alone — that is somebody's footage, whatever the index thinks.
  ///
  /// The list is taken here, before any camera starts, so a segment a camera begins in the same
  /// folder after the resume can never be mistaken for one. Only this take's folder is searched.
  private func discardUnreadableOrphans(ofRecording id: Int64) {
    guard let mine = try? index.reconcile(recordings: [id]).orphans, !mine.isEmpty else { return }
    Task.detached(priority: .utility) {
      for url in mine {
        let asset = AVURLAsset(url: url)
        let readable = (try? await asset.load(.duration))?.seconds ?? 0
        if readable <= 0.05 { try? FileManager.default.removeItem(at: url) }
      }
    }
  }

  public func shutdown() async {
    pollTimer?.invalidate()
    retentionTimer?.invalidate()
    programmeRecording.stopHeartbeat()
    if isRecording { await stopRecording() }
    endPeek()
    pictureInPicture.tearDown()
    router.audioPlayer.stop()
    router.removeAll()
    discovery?.stop()
    for controller in webControllers.values { controller.stop() }
    webControllers.removeAll()
    controlServer?.stop()
    controlServer = nil
    remoteInput.stop()
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

  /// Every live transport that could be built, as one discovery. A single one is returned on its
  /// own rather than wrapped, so a rig with one transport available behaves exactly as before.
  private static func liveDiscovery(
    _ factory: (@Sendable (SourceKind) -> SourceDiscovery?)?
  ) -> SourceDiscovery? {
    let live = SourceKind.allCases.filter(\.isLive).compactMap { factory?($0) }
    guard live.count > 1 else { return live.first }
    return CompositeSourceDiscovery(live)
  }

  /// Whether two profiles mean the same set of cameras. Only the live pair does.
  private static func describesSameSession(_ lhs: SourceProfile, _ rhs: SourceProfile) -> Bool {
    lhs == rhs || (kind(for: lhs).isLive && kind(for: rhs).isLive)
  }

  private static func kind(for profile: SourceProfile) -> SourceKind {
    switch profile {
    case .synthetic4: .synthetic
    case .file4: .file
    case .rtsp: .rtsp
    case .ndi: .ndi
    }
  }

  private func startDiscovery() {
    releasePeekConnection()
    if peekID != nil {
      peekMode = .unavailable
      peekStatus = Self.peekConnecting
    }
    discovery?.stop()
    let kind = Self.kind(for: sourceProfile)
    selections = SourceSelectionRules.retaining(selections, kind: kind)
    selectionStore.save(selections)
    refreshGridSnapshot()
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
    case .rtsp, .ndi:
      // Both live transports, always, presented as one list. Paul's deployment is a mix of NDI
      // converters and RTSP phones, and there is no reason for the operator to choose between
      // protocols when the app can simply run both and let them pick cameras.
      //
      // Injected by the app target, so this module still never imports a transport.
      Self.liveDiscovery(discoveryFactory)
    }

    guard let discovery else {
      self.discovery = nil
      discoveryUnavailableReason = "No camera discovery is available for this profile"
      telemetry.mutate { $0.sourceAvailable = false }
      eventControl.attach(to: nil)
      return
    }

    self.discovery = discovery
    discoveryUnavailableReason = nil
    telemetry.mutate {
      $0.sourceAvailable = discovery.kinds.contains(where: \.isLive)
      $0.discoveryStatus = discovery.diagnostic
    }
    discovery.start { [weak self] discovered in
      Task { @MainActor in self?.applyDiscovery(discovered) }
    }
    // Every discovery built here, so a profile change rejoins the new one's sweep (or, for a
    // profile that does not sweep, has event control run its own).
    eventControl.attach(to: discovery)
  }

  private func applyDiscovery(_ discovered: [DiscoveredSource]) {
    // Through the audio store, because a sighting can be a row the list has never held: a camera
    // that renamed itself, or one whose identity only hardened after this launch started. Merged
    // in it arrives with the defaults, and "audio on" is the default.
    selections = SourceAudioRules.applying(
      audioSettings,
      to: SourceSelectionRules.merge(existing: selections, discovered: discovered),
      key: audioKey(for:)
    )
    selectionStore.save(selections)
    refreshGridSnapshot()
    cameraRecords = cameras.records
    noteEndpoints(of: discovered)
    telemetry.mutate {
      $0.discoveredSourceCount = discovered.count
      $0.discoveryStatus = discovery?.diagnostic ?? ""
    }
    rebuildRelocatedPipelines(discovered)
    pushDisplayNamesToTiles()
    if let peekID, !selections.contains(where: { $0.id == peekID }) {
      endPeek()
    } else {
      reconcilePeek()
    }
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
    noteRenameInLiveTake(id)
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
    if let sourceIndex = selections.first(where: { $0.id == id })?.sourceIndex,
       let cname = advertisement.cname, !cname.isEmpty {
      telemetry.mutateTile(sourceIndex) { $0.cname = cname }
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
    audioStore.clear()
    audioSettings = [:]
    programSourceStore.clear()
    preferredProgramSourceID = nil
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
    let identities = cameras.resolve(
      endpoints: refreshEndpoints(from: discovery),
      advertisements: discovery.advertisements
    )
    // Per transport, because the kind stamped here decides how the row is later connected to. One
    // list for both would rebind an NDI camera as an RTSP one.
    let republished = discovery.children.flatMap { child in
      refreshEndpoints(from: child).map { endpoint in
        DiscoveredSource(
          id: identities[endpoint]?.id ?? SourceID(
            "\(CameraIdentityRules.sessionIDPrefix)\(UUID().uuidString.lowercased())"
          ),
          kind: child.kind,
          advertisedName: identities[endpoint]?.name ?? CameraIdentityRules.unnamedFallback,
          address: endpoint.url
        )
      }
    }
    guard !republished.isEmpty else { return }
    // Rows keyed by the old identity are dropped rather than left behind: after a rebinding they
    // describe a camera that is now on another row. Limited to the transports that answered, or
    // the ones that cannot answer at all lose every camera they had found.
    selections = SourceAudioRules.applying(
      audioSettings,
      to: SourceSelectionRules.merging(
        existing: selections,
        discovered: republished,
        limitedTo: Set(republished.map(\.kind))
      ),
      key: audioKey(for:)
    )
    selectionStore.save(selections)
    refreshGridSnapshot()
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
      telemetry.mutateTile(pipeline.sourceIndex) { $0.displayName = name }
    }
    syncCameraTelemetry()
  }

  // MARK: - Cameraman control

  /// What the camera on a row says about itself: its own answer to discovery's control probe, or
  /// its Bonjour record while the probe has not answered yet.
  public func cameraAdvertisement(for id: SourceID) -> CameraAdvertisement? {
    guard let endpoint = endpoint(for: id) else { return nil }
    return pairedAdvertisement(for: endpoint)
  }

  /// Found by the uuid the socket presented, not by the address an old advertisement shares with it.
  private func pairedAdvertisement(for endpoint: CameraEndpoint) -> CameraAdvertisement? {
    CameraIdentityRules.pair(
      endpoints: [ endpoint ],
      advertisements: discovery?.advertisements ?? [],
      claims: cameras.advertisement(for: endpoint).map { [ endpoint: $0 ] } ?? [:]
    )[endpoint]
  }

  /// The socket whose parameter channel drives this row's tile: the linked phone's when the row
  /// has a link, otherwise the row's own. Identity, naming and the media session keep using
  /// `endpoint(for:)`; only telemetry and control go through here.
  public func controlEndpoint(for id: SourceID) -> CameraEndpoint? {
    if let control = selections.first(where: { $0.id == id })?.linkedControlID {
      return endpoint(for: control)
    }
    return endpoint(for: id)
  }

  public func controlAdvertisement(for id: SourceID) -> CameraAdvertisement? {
    guard let endpoint = controlEndpoint(for: id) else { return nil }
    return pairedAdvertisement(for: endpoint)
  }

  /// A TS Cameraman that answered the control probe with its UUID and `params/1`, so the tile gets
  /// its controls whether or not its Bonjour record ever reached this network. A camera without the
  /// verbs, or a NearStream, gets nothing rather than a screen that cannot connect.
  public func isCameramanControllable(sourceIndex: Int) -> Bool {
    guard let pipeline = router.pipeline(at: sourceIndex) else { return false }
    return controlAdvertisement(for: pipeline.sourceID)?.isControllable == true
  }

  /// Opens the phone's own operating screen for the camera on a tile. For a linked tile the
  /// picture behind the controls is the tile's own (the NDI capture) and the parameter session
  /// goes to the linked phone.
  public func openCameraControl(sourceIndex: Int) {
    guard activeSheet == nil, let pipeline = router.pipeline(at: sourceIndex),
          let endpoint = controlEndpoint(for: pipeline.sourceID),
          controlAdvertisement(for: pipeline.sourceID)?.isControllable == true
    else { return }
    stopCameraControl()
    let session = RTSPParameterSession(
      host: endpoint.host,
      port: endpoint.port,
      path: endpoint.path,
      userAgent: "TS Director/1.0"
    )
    // A phone that does not zoom past its own ceiling gets Director's zoom on top, the same 2x in
    // yellow that Cameraman gives itself.
    let id = pipeline.sourceID
    let model = RemoteCameraControl(
      transport: session,
      animatesChrome: !launch.isUITest,
      extendsWithDirectorZoom: true,
      directorZoom: digitalZoom(for: id)
    )
    model.onDirectorZoom = { [weak self] zoom in self?.setDigitalZoom(zoom, for: id) }
    model.start()
    activeCameraControl = model
    activeCameraControlIndex = sourceIndex
    activeSheet = .cameraControl(sourceIndex: sourceIndex)
  }

  /// The tile's three-dot button: the phone's own screen for a controllable Cameraman, and
  /// Director's zoom for any other camera.
  public func openCameraMenu(sourceIndex: Int) {
    if isCameramanControllable(sourceIndex: sourceIndex) {
      openCameraControl(sourceIndex: sourceIndex)
    } else {
      openDigitalZoom(sourceIndex: sourceIndex)
    }
  }

  public func openDigitalZoom(sourceIndex: Int) {
    guard activeSheet == nil, router.pipeline(at: sourceIndex) != nil else { return }
    activeSheet = .digitalZoom(sourceIndex: sourceIndex)
  }

  public func closeDigitalZoom() {
    if case .digitalZoom = activeSheet { activeSheet = nil }
  }

  public func digitalZoom(for id: SourceID) -> Double {
    selections.first(where: { $0.id == id })?.digitalZoom ?? 1
  }

  /// Director's zoom on one camera's picture: saved with the row and applied to its pipeline.
  public func setDigitalZoom(_ zoom: Double, for id: SourceID) {
    let before = digitalZoom(for: id)
    SourceSelectionRules.setDigitalZoom(zoom, for: id, in: &selections)
    let after = digitalZoom(for: id)
    router.pipeline(for: id)?.setDigitalZoom(after)
    guard after != before else { return }
    selectionStore.save(selections)
  }

  public func closeCameraControl() {
    if case .cameraControl = activeSheet { activeSheet = nil }
    stopCameraControl()
  }

  /// Tears the model down. Idempotent, because the cover's disappearance and the close button can
  /// both arrive.
  public func stopCameraControl() {
    activeCameraControl?.stop()
    activeCameraControl = nil
    activeCameraControlIndex = nil
    telemetry.mutate { $0.cameraControl = CameraControlTelemetry() }
  }

  /// Starts a poller for every controllable Cameraman on the grid and stops the ones that left.
  private func syncCameraTelemetry() {
    var wanted: [SourceID: CameraEndpoint] = [:]
    for pipeline in router.activePipelines {
      guard let endpoint = controlEndpoint(for: pipeline.sourceID),
            controlAdvertisement(for: pipeline.sourceID)?.isControllable == true
      else {
        telemetry.mutateTile(pipeline.sourceIndex) {
          $0.hasCameraControl = false
          $0.cameraThermal = nil
          $0.cameraBatteryPercent = nil
          $0.cameraBatteryCharging = false
        }
        continue
      }
      wanted[pipeline.sourceID] = endpoint
      telemetry.mutateTile(pipeline.sourceIndex) { $0.hasCameraControl = true }
    }
    for (id, poller) in cameraTelemetryPollers where wanted[id] != poller.endpoint {
      poller.stop()
      cameraTelemetryPollers[id] = nil
    }
    for (id, endpoint) in wanted where cameraTelemetryPollers[id] == nil {
      let poller = CameraTelemetryPoller(endpoint: endpoint) { [weak self] reading in
        guard let self, let index = router.activePipelines.first(where: { $0.sourceID == id })?.sourceIndex else { return }
        telemetry.mutateTile(index) {
          $0.cameraThermal = reading.thermal
          $0.cameraBatteryPercent = reading.batteryPercent
          $0.cameraBatteryCharging = reading.batteryCharging
        }
      }
      poller.start()
      cameraTelemetryPollers[id] = poller
    }
  }

  private func recordCameraControlTelemetry() {
    guard let model = activeCameraControl else { return }
    let index = activeCameraControlIndex
    var record = CameraControlTelemetry()
    record.open = true
    record.sourceIndex = index
    record.responding = model.isResponding
    record.zoom = model.displayedZoom
    record.position = model.position.rawValue
    record.thermal = model.thermalLevel.rawValue
    record.batteryPercent = model.battery?.percent
    record.codec = model.settings.codec.sdpEncodingName
    record.bitrateKbps = model.settings.bitrate / 1000
    record.lastError = model.lastError ?? ""
    record.polls = model.polls
    record.writes = model.writes
    telemetry.mutate { $0.cameraControl = record }
  }

  /// Keeps the last sweep's order — identified cameras first — so a rename does not bury a VM33
  /// under an unidentified RTSP host that sorts earlier by address.
  /// Endpoints belonging to one transport: what it currently sees, plus the rows already keyed to
  /// cameras of its own kind. Rows are filtered by kind because with both transports live an
  /// unfiltered list would hand every row's address to both, and republish each camera twice under
  /// the wrong protocol.
  private func refreshEndpoints(from discovery: SourceDiscovery) -> [CameraEndpoint] {
    let kinds = Set(discovery.kinds)
    let fromSweep = discovery.currentSources.compactMap { CameraEndpoint(address: $0.address) }
    let ownRows = selections.filter { kinds.contains($0.kind) }.map(\.id)
    let fromRows = Array(Set(ownRows.compactMap { rowEndpoints[$0] }))
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
  ///
  /// `rtsp` and `ndi` are not a change from one another. Both live transports run together, so
  /// those two profiles name the same session and tearing the grid down between them would stop a
  /// recording and drop every tile to answer a question nobody asked.
  private func applySourceProfile(_ profile: SourceProfile) async {
    let profileChanged = !Self.describesSameSession(profile, sourceProfile)
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

  // MARK: - Source layout

  /// Swaps `sourceIndex` into `slot` with whoever is already there. Saved on drop, not here, so
  /// a drag that crosses several tiles is one write.
  public func moveSource(_ sourceIndex: Int, toSlot slot: Int) {
    sourceLayout.moveSource(sourceIndex, toSlot: slot)
  }

  /// Parks Output in `corner`; the sources reflow into the cells it leaves. Saved on drop, like a
  /// source swap.
  public func moveProgram(to corner: ProgramCorner) {
    sourceLayout.programCorner = corner
  }

  public func commitSourceLayout() {
    layoutStore.save(sourceLayout)
    telemetry.mutate {
      $0.sourceLayout = sourceLayout.displayOrder
      $0.outputCorner = sourceLayout.programCorner.rawValue
    }
  }

  public func setSourceLayout(_ layout: SourceLayout) {
    sourceLayout = layout
    commitSourceLayout()
  }

  // MARK: - Selection

  @discardableResult
  public func setEnabled(_ enabled: Bool, for id: SourceID) -> SourceSelectionRules.EnableResult {
    let result = SourceSelectionRules.setEnabled(enabled, for: id, in: &selections)
    if result == .rejectedAtCap {
      statusMessage = "Five sources maximum — turn one off first"
    } else if result == .linkedForControl {
      statusMessage = "That camera is linked for remote control — unlink it first"
    } else {
      statusMessage = nil
      selectionStore.save(selections)
      refreshGridSnapshot()
      switch result {
      case let .enabled(sourceIndex):
        rememberProgramSource(id)
        if peekID == id {
          // The modal's temporary session is the camera's only connection. The tile has to
          // take it over; leaving both up is a second login most cameras refuse.
          releasePeekConnection()
          peekStartError = nil
          peekPipelineHandoffID = id
          peekMode = .livePipeline
          peekStatus = Self.peekConnecting
        }
        Task {
          await startSource(id: id, sourceIndex: sourceIndex)
          if peekPipelineHandoffID == id { peekPipelineHandoffID = nil }
          if peekID == id {
            if router.pipeline(for: id) == nil, peekStartError == nil,
               selections.first(where: { $0.id == id })?.isEnabled == true {
              peekStartError = Self.peekUnavailable
            }
            reconcilePeek()
          }
        }
      case .disabled:
        if peekPipelineHandoffID == id { peekPipelineHandoffID = nil }
        stopSource(id)
        if peekID == id {
          peekStartError = nil
          reconcilePeek()
        }
      default:
        break
      }
    }
    return result
  }

  public func assignSource(slot: Int, to id: SourceID) {
    switch SourceSelectionRules.assign(slot: slot, to: id, in: &selections) {
    case .unchanged, .unknownSource, .invalidSlot:
      return
    case let .applied(move):
      selectionStore.save(selections)
      refreshGridSnapshot()
      if let move {
        returnToLive(sourceIndex: move.from)
        returnToLive(sourceIndex: move.to)
        router.reassign(from: move.from, to: move.to)
      }
    }
  }

  public func rename(_ name: String?, for id: SourceID) {
    SourceSelectionRules.rename(name, for: id, in: &selections)
    selectionStore.save(selections)
    refreshGridSnapshot()
    if let pipeline = router.pipeline(for: id),
       let selection = selections.first(where: { $0.id == id }) {
      telemetry.mutateTile(pipeline.sourceIndex) { $0.displayName = selection.displayName }
    }
    noteRenameInLiveTake(id)
  }

  public var enabledSelections: [SourceSelection] {
    SourceSelectionRules.enabled(in: selections)
  }

  // MARK: - Linking

  /// Rows the picker may offer as `video`'s control: Cameramen that answer with the parameter
  /// vocabulary and are not already spoken for.
  public func linkCandidates(for video: SourceID) -> [SourceSelection] {
    SourceSelectionRules.linkCandidates(for: video, in: selections) { candidate in
      cameraAdvertisement(for: candidate.id)?.isControllable == true
    }
  }

  public func isLinkedControl(_ id: SourceID) -> Bool {
    SourceSelectionRules.isLinkedControl(id, in: selections)
  }

  public func linkedControl(for video: SourceID) -> SourceSelection? {
    guard let control = selections.first(where: { $0.id == video })?.linkedControlID else { return nil }
    return selections.first { $0.id == control }
  }

  public func linkedVideo(forControl id: SourceID) -> SourceSelection? {
    guard let video = SourceSelectionRules.linkedVideoID(forControl: id, in: selections) else { return nil }
    return selections.first { $0.id == video }
  }

  /// Points `video`'s tile at `control`'s parameter channel. If the phone had a tile of its own,
  /// that media session ends now; from here on only `RTSPParameterSession`s are opened to it,
  /// which is what keeps its radio and encoder quiet.
  @discardableResult
  public func linkSource(video: SourceID, control: SourceID) -> SourceSelectionRules.LinkResult {
    let hadTile = selections.first { $0.id == control }?.isEnabled ?? false
    let result = SourceSelectionRules.link(video: video, control: control, in: &selections)
    guard result == .linked else { return result }
    statusMessage = nil
    selectionStore.save(selections)
    refreshGridSnapshot()
    if hadTile { stopSource(control) }
    applyAudioContributors()
    syncCameraTelemetry()
    return result
  }

  /// The red X on the phone's row.
  public func unlinkSource(control: SourceID) {
    SourceSelectionRules.unlink(control: control, in: &selections)
    selectionStore.save(selections)
    refreshGridSnapshot()
    syncCameraTelemetry()
  }

  /// "Unlink" from the picture's own link menu.
  public func unlinkSource(video: SourceID) {
    SourceSelectionRules.unlink(video: video, in: &selections)
    selectionStore.save(selections)
    refreshGridSnapshot()
    syncCameraTelemetry()
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
    endPeek()
    activeSheet = nil
    discovery?.setPeriodicSearch(false)
  }

  /// Opens the preview modal for one row. Does not enable the camera and does not take a slot.
  public func beginPeek(id: SourceID) {
    guard selections.contains(where: { $0.id == id }) else { return }
    if peekID == id {
      if peekMode == .temporary, peekSource?.isRunning == true { return }
      if peekMode == .livePipeline,
         router.pipeline(for: id) != nil || peekPipelineHandoffID == id {
        return
      }
    } else {
      releasePeekConnection()
      peekStartError = nil
    }
    peekID = id
    reconcilePeek()
  }

  public func endPeek() {
    peekID = nil
    peekMode = .unavailable
    peekStatus = nil
    peekStartError = nil
    peekPipelineHandoffID = nil
    releasePeekConnection()
  }

  /// The renderer the modal should display, or nil while there is only a status line.
  public func peekVideoRenderer() -> TileRenderer? {
    guard let id = peekID else { return nil }
    switch peekMode {
    case .livePipeline:
      return router.pipeline(for: id)?.renderer
    case .temporary:
      return peekRenderer
    case .unavailable:
      return nil
    }
  }

  /// Keeps the open modal on one connection. An enabled row waits for its tile; a disabled row
  /// gets a pixel-only source that is never asked to archive.
  private func reconcilePeek() {
    guard let id = peekID else { return }
    let hasLivePipeline = router.pipeline(for: id) != nil
    let enabled = selections.first(where: { $0.id == id })?.isEnabled == true

    if hasLivePipeline {
      peekPipelineHandoffID = nil
      peekStartError = nil
      releasePeekConnection()
      peekMode = .livePipeline
      peekStatus = nil
      return
    }
    if peekPipelineHandoffID == id {
      releasePeekConnection()
      peekMode = .livePipeline
      peekStatus = Self.peekConnecting
      return
    }
    if enabled {
      // The tile is coming up, or it failed. Either way a second session is the wrong fix.
      releasePeekConnection()
      peekMode = .livePipeline
      peekStatus = peekStartError ?? Self.peekConnecting
      return
    }
    peekStartError = nil

    let discovered = discovery.flatMap {
      SourceSelectionRules.startableSource(id: id, among: $0.currentSources)
    }
    switch SourcePeekRules.target(hasLivePipeline: false, isDiscovered: discovered != nil) {
    case .temporary:
      guard let discovered else { return }
      adoptTemporaryPeek(discovered)
    case .unavailable, .livePipeline:
      releasePeekConnection()
      peekMode = .unavailable
      peekStatus = Self.peekUnavailable
    }
  }

  private func adoptTemporaryPeek(_ discovered: DiscoveredSource) {
    if peekSource?.isRunning == true,
       peekSource?.sourceID == discovered.id,
       peekAddress == discovered.address {
      peekMode = .temporary
      peekStatus = nil
      return
    }
    releasePeekConnection()
    guard let discovery else {
      peekMode = .unavailable
      peekStatus = Self.peekUnavailable
      return
    }
    do {
      let source = try discovery.makeSource(for: discovered)
      let renderer = peekRenderer
      let converter = converter
      // Pixel sink only, and no `setArchiving`. NDI and synthetic cameras encode their archive
      // themselves; a preview must not spend one of those sessions on a picture nobody is recording.
      try source.start(sinks: FrameSinks(pixel: { frame in
        guard let converted = converter.convert(frame) else { return }
        renderer.enqueue(converted)
      }))
      peekSource = source
      peekAddress = discovered.address
      peekMode = .temporary
      peekStatus = nil
    } catch {
      peekMode = .unavailable
      peekStatus = "\(error)"
    }
  }

  private func releasePeekConnection() {
    peekSource?.stop()
    peekSource = nil
    peekAddress = nil
    peekRenderer.invalidateFormatCache()
  }

  public func enterDirecting() async {
    ensureProductionReady()
    await syncEnabledSources()
    applyProgramSelection(force: true)
    dismissCameras()
    router.programRenderer.prepareForLive()
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
    restartLinkServer()
    eventControl.resumed()
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
    // Suspended, iOS leaves a listener accepting connections it never answers, and it does not
    // recover; so it goes down here and comes back in `handleForeground`.
    stopLinkServer()
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
      guard let sourceIndex = selection.sourceIndex else { continue }
      await startSource(id: selection.id, sourceIndex: sourceIndex)
    }
    applyProgramSelection()
    applyAudioContributors()
    if peekID != nil { reconcilePeek() }
  }

  private func startSource(id: SourceID, sourceIndex: Int) async {
    if let existing = router.pipeline(for: id) {
      if existing.sourceIndex != sourceIndex || !existing.sourceIsRunning {
        stopSource(id)
      } else {
        applyProgramSelection()
        return
      }
    }
    if router.pipeline(at: sourceIndex) != nil {
      return
    }
    guard let discovery else { return }
    guard let selection = selections.first(where: { $0.id == id }), selection.isEnabled else { return }
    guard let discovered = SourceSelectionRules.startableSource(
      id: id,
      among: discovery.currentSources
    ) else { return }
    do {
      let source = try discovery.makeSource(for: discovered)
      observeStreamIdentity(source, id: id)
      let pipeline = SourcePipeline(
        sourceID: id,
        sourceIndex: sourceIndex,
        source: source,
        converter: converter,
        telemetry: telemetry
      )
      router.add(pipeline)
      pipeline.setDigitalZoom(selection.digitalZoom)
      try pipeline.start()
      router.audioMixer.start()
      router.recordingMixer.start()
      router.audioPlayer.start()
      pipelineEndpoints[id] = CameraEndpoint(address: discovered.address)
      telemetry.mutateTile(sourceIndex) { $0.displayName = selection.displayName }
      applyProgramSelection()
      applyAudioContributors()
      if isRecording, let recordingID {
        attachArchive(to: pipeline, recordingID: recordingID)
        attachProxy(to: pipeline)
      }
    } catch {
      if peekID == id {
        peekStartError = "\(error)"
      }
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
    router.remove(sourceIndex: pipeline.sourceIndex)
    if let index = router.currentProgramSource,
       let remaining = router.pipeline(at: index) {
      rememberProgramSource(remaining.sourceID)
    }
    applyAudioContributors()
  }

  private func activateEnabledSources() async {
    await syncEnabledSources()
  }

  /// Points the mixer at whichever sources are ticked for audio. Called after activation and again
  /// whenever the operator changes a toggle, so the mix follows the switches live, mid-take included:
  /// the old source fades out and the new one fades in at the same picture in the stream and the
  /// recording (`TileRouter.setAudioContributors`).
  public func applyAudioContributors() {
    let ids = Set(SourceSelectionRules.audioContributors(in: selections).map(\.id))
    router.setAudioContributors(ids)
    applyInputGains()
  }

  /// Which camera carries the sound, at any time, recording or not.
  ///
  /// The recording's master takes the recording mix as one continuous track on the mix's own sample
  /// clock, and each camera's sound is placed on that clock by its own capture time, so the master's
  /// placement does not depend on which camera is heard. A camera whose sound drops out mid-game can
  /// be swapped for another without stopping the take.
  public func setUsesAudio(_ usesAudio: Bool, for id: SourceID) {
    SourceSelectionRules.setUsesAudio(usesAudio, for: id, in: &selections)
    // Every row's audio may have moved, not just this one: turning one on turns the others off.
    for selection in selections { rememberAudio(for: selection.id) }
    selectionStore.save(selections)
    refreshGridSnapshot()
    applyAudioContributors()
  }

  public func setInputGain(_ gain: Double, for id: SourceID) {
    SourceSelectionRules.setInputGain(gain, for: id, in: &selections)
    rememberAudio(for: id)
    selectionStore.save(selections)
    refreshGridSnapshot()
    applyInputGains()
  }

  /// The camera one row is about, found from the row's own id rather than from its address: at
  /// launch nothing has been discovered yet and no row has an address, and that is exactly when
  /// the remembered decisions have to be readable.
  private func cameraRecord(for selection: SourceSelection) -> CameraRecord? {
    guard let uuid = UUID(uuidString: selection.id.rawValue) else { return nil }
    return cameras.record(id: uuid)
  }

  private func audioKey(for selection: SourceSelection) -> String? {
    SourceAudioRules.key(for: selection, record: cameraRecord(for: selection))
  }

  /// Files the decision the operator just made under the camera it was made about.
  ///
  /// The fader calls this for every point of a drag, so an unchanged value writes nothing.
  private func rememberAudio(for id: SourceID) {
    guard let selection = selections.first(where: { $0.id == id }) else { return }
    let known = audioSettings
    SourceAudioRules.remembering(selection, in: &audioSettings, key: audioKey(for:))
    guard audioSettings != known else { return }
    audioStore.save(audioSettings)
  }

  private func applyInputGains() {
    let gains = Dictionary(selections.map { ($0.id, $0.inputGain) }, uniquingKeysWith: { _, latest in latest })
    router.setInputGains(gains)
  }

  public func selectProgram(sourceIndex: Int, persist: Bool = true) {
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }
    let changed = router.currentProgramSource != sourceIndex
    router.selectProgram(sourceIndex: sourceIndex)
    if persist { rememberProgramSource(pipeline.sourceID) }
    // Every cut as it happens, while a take is open. `persist` is the operator's own choice
    // against the app picking a camera because the chosen one is not live, and a fallback must
    // not become the take's preference when it is picked up again.
    if changed, isRecording, let recordingID {
      try? index.insertProgramCut(
        recordingID: recordingID,
        wall: clock.now,
        sourceID: pipeline.sourceID,
        intended: persist
      )
    }
    applyProgramOverlays()
  }

  /// Keeps the open take's snapshot current when the grid changes mid-take.
  ///
  /// Called from every place that persists the selection list, which includes each discovery
  /// sweep's merge — so it has to be cheap when nothing has actually changed, and most sweeps
  /// change nothing. Comparing the encoded bytes is what keeps this an event rather than a
  /// steady trickle of writes for the length of a game.
  private func refreshGridSnapshot() {
    guard isRecording, let recordingID else { return }
    saveGridSnapshot(for: recordingID)
  }

  /// Writes down the grid this take is recording with, if it is not already what is on record.
  private func saveGridSnapshot(for recordingID: Int64) {
    guard let data = try? JSONEncoder().encode(selections) else { return }
    guard data != lastGridSnapshot else { return }
    try? index.saveSelections(data, for: recordingID)
    lastGridSnapshot = data
  }

  private func rememberProgramSource(_ id: SourceID) {
    preferredProgramSourceID = id
    programSourceStore.save(id)
  }

  /// Puts Output on the persisted camera if that tile is live, otherwise the last enabled
  /// camera that is actually running.
  private func applyProgramSelection(force: Bool = false) {
    let preferred = SourceSelectionRules.programSourceIndex(
      preferring: preferredProgramSourceID,
      among: selections
    )
    let target = preferred.flatMap { router.pipeline(at: $0) != nil ? $0 : nil }
      ?? SourceSelectionRules.enabled(in: selections)
        .reversed()
        .compactMap(\.sourceIndex)
        .first { router.pipeline(at: $0) != nil }
    guard let target else { return }
    if force || router.currentProgramSource != target {
      selectProgram(sourceIndex: target, persist: preferred == target)
    }
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
    guard distributorExport == nil else {
      statusMessage = "TS Distributor is exporting — record once it has finished"
      return
    }
    let now = clock.now
    let recordingID: Int64
    // The take's row, with the encoding it is recorded with kept for its exports; the master's
    // anchors belong to it until it stops.
    let settings = RecordingSettings(config: config)
    do {
      recordingID = try programmeRecording.open(at: now, settings: settings)
    } catch {
      statusMessage = "Could not start recording: \(error)"
      return
    }
    // The grid as it is at this instant, so the take can be picked up against the cameras it was
    // actually recording rather than whatever the stores hold at the next launch. Cleared first:
    // an identical grid to the previous take's is still a row this take has not got.
    lastGridSnapshot = nil
    saveGridSnapshot(for: recordingID)

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
      // The programme settings this take was recorded with, saved above with the take.
      try programmeRecording.startProgramme(at: now, settings: settings)
    } catch {
      let message = "Program output unavailable: \(error)"
      statusMessage = message
      telemetry.mutate { $0.dvr.lastError = message }
    }

    isRecording = true
    // Whatever is on air at the start is the take's first cut. Without it a take that nobody
    // touched has no record of which camera it opened on.
    if let source = router.currentProgramSource,
      let pipeline = router.pipeline(at: source)
    {
      try? index.insertProgramCut(
        recordingID: recordingID, wall: now, sourceID: pipeline.sourceID, intended: true
      )
    }
    telemetry.mutate {
      $0.dvr.isRecording = true
      $0.dvr.recordingStartedAt = now.seconds
      $0.dvr.resumeCount = 0
      $0.dvr.lastDowntimeSeconds = 0
    }
    beginLiveSession(recording: recordingID)
    // Every take started with an event chosen is filed under it, streamed or
    // not; the one started by streaming included.
    eventCoordinator.recordingStarted(take: recordingID)
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

  // MARK: - TeamStation

  private func makeAccount() -> TeamStationAccount {
    let clock = self.clock
    return TeamStationAccount(
      serverURL: AppServer.url,
      deviceName: UIDevice.current.name,
      appOrigin: AppServer.appOrigin,
      // TeamStation keys this Director's stream on the installation and lists it by model.
      installId: DirectorInstallID.persisted(in: .standard),
      deviceModel: DeviceModelName.current,
      // The time it reads, as everything else Director times, is on the steady wall clock.
      clock: { clock.now.seconds }
    )
  }

  /// A web address the operating system handed Director: a sign-in link from
  /// the e-mail, on Director's own link host. Signs in with it, and says how
  /// that went in the status toast. `false` for any other address.
  @discardableResult
  public func handleSignInLink(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "https" else { return false }
    Task { @MainActor in
      let outcome = await teamStation.signIn(link: url)
      if let message = outcome.message { statusMessage = message }
    }
    return true
  }

  /// Where the Stream button publishes.
  ///
  /// Either the URL the operator typed, or the game they picked — whose URL
  /// this app holds and never shows, because the event *is* the destination as
  /// far as anybody using it is concerned.
  public var streamDestinationURL: String {
    switch config.streamDestination {
    case .url: return config.streamURL
    case .event: return teamStation.chosen?.streamURL ?? ""
    }
  }

  /// Where a stream would go, without its key: the URL's scheme, host, port and application for a
  /// typed URL, the game's id and title for an event. A test reads it before streaming.
  var streamTargetDescription: String {
    switch config.streamDestination {
    case .url:
      return Self.withoutStreamKey(config.streamURL)
    case .event:
      guard let chosen = teamStation.chosen else { return "" }
      return "\(chosen.gameId) \(chosen.title)"
    }
  }

  /// `rtmp://host:1935/live/key` → `rtmp://host:1935/live`. The key is the last path component.
  static func withoutStreamKey(_ url: String) -> String {
    guard var components = URLComponents(string: url), components.host != nil else { return "" }
    components.user = nil
    components.password = nil
    components.query = nil
    var path = components.path.split(separator: "/", omittingEmptySubsequences: true)
    if path.count > 1 { path.removeLast() }
    components.path = path.isEmpty ? "" : "/" + path.joined(separator: "/")
    return components.string ?? ""
  }

  public func startStreaming() {
    startStreaming(reason: .start)
  }

  /// `.redial` for the automatic restart at launch, which may only put back the stream held.
  private func startStreaming(reason: StreamSessionController.DialReason) {
    guard !isStreaming else { return }
    guard distributorExport == nil else {
      statusMessage = "TS Distributor is exporting — stream once it has finished"
      return
    }
    // An event with no address yet is claimed as the stream is dialled, so
    // only an event that was never chosen stops it here.
    let ready = config.streamDestination == .event
      ? teamStation.chosen != nil
      : !config.streamURL.isEmpty
    guard ready else {
      // Saying which of the two destinations is empty is the difference
      // between a fixable message and a shrug.
      reportStreamError(
        config.streamDestination == .event
          ? "Pick a TeamStation event in Settings first"
          : "No stream URL set in Settings"
      )
      return
    }
    streamErrorGate.reset()
    streamWanted = true
    liveStartWanted = true
    isStreaming = true
    // A stream is always recorded. The local take is the only copy that is not
    // at the mercy of the uplink, it is what replay cuts from during the game,
    // and it is what gets uploaded afterwards to replace a live stream that
    // was squeezed through a field's connection. Recording without streaming
    // stays possible; streaming without recording is a game nobody can get
    // back. Stopping the stream deliberately does not stop it: an operator who
    // drops the publish is usually still filming.
    if !isRecording { startRecording() }
    beginLiveSession(streaming: true)
    streamSession.start(reason: reason)
  }

  /// Chooses the game this Director covers, from Settings' event picker.
  @discardableResult
  public func pickEvent(_ event: TeamStationEvent, destination: StreamDestination) async -> Bool {
    defer { updateScoreboards() }
    return await eventCoordinator.pick(event: event, destination: destination)
  }

  /// Settings' Clear: this Director covers no game.
  public func clearEvent() {
    eventCoordinator.clear()
    updateScoreboards()
  }

  /// Settings' "Set event on nearby devices". Saved at once, like the event row above it, rather
  /// than with SAVE: it acts on devices now.
  public func setEventControlEnabled(_ on: Bool) {
    persistedConfig.eventControlEnabled = on
    configStore.save(persistedConfig)
    config.eventControlEnabled = on
    eventControl.setEnabled(on)
  }

  /// Event control follows the account: sign-in, sign-out, another account, a rejected token.
  private func watchAccountForEventControl() {
    withObservationTracking {
      _ = teamStation.scope
      _ = teamStation.user
    } onChange: { [weak self] in
      Task { @MainActor in
        self?.eventControl.accountChanged()
        self?.watchAccountForEventControl()
      }
    }
  }

  /// Settings' destination radio. Choosing the event claims it now.
  public func streamDestinationChanged(to destination: StreamDestination) {
    Task { await eventCoordinator.destinationChanged(to: destination) }
  }

  /// Opens the publish, and puts it back when it drops on its own.
  ///
  /// A drop is not a stop. The send times out whenever the uplink carries less than the programme
  /// for longer than the socket allows — measured on the rig, a 1.2 Mbit cap under a 4 Mbps
  /// programme ends the publish in about twenty seconds — and before this the stream stayed off for
  /// the rest of the session, with the operator's only warning a toast they had to be watching for.
  /// The controller redials with backoff, at once when the network comes back, and stops for good
  /// when TeamStation says the stream was ended.
  private func makeStreamSession() -> StreamSessionController {
    StreamSessionController(
      publisher: programStreamer,
      host: .init(
        requestURL: { [weak self] reason in
          guard let self else { throw CancellationError() }
          // The event is claimed here if it never was, and asked for again if it was: a key can
          // have been rotated since, and offline the cached address is what there is.
          return try await self.eventCoordinator.streamURL(
            for: reason,
            destination: self.dialConfig.streamDestination,
            typed: self.config.streamURL
          )
        },
        settings: { [weak self] in StreamSettings(config: self?.dialConfig ?? .default) },
        explainDialFailure: { [weak self] error in
          // TeamStation knows better than the socket does why a publish to one of its games will
          // not start, and it has already written the reason on the game's row. Asked only for a
          // game we picked, and only when the dial failed, so the ordinary path costs nothing.
          var message = Self.streamErrorMessage(error)
          if self?.dialConfig.streamDestination == .event,
            let said = await self?.teamStation.reasonForRefusal()
          {
            message = said
          }
          return message
        },
        // A URL that cannot be parsed is not worth retrying.
        isRetryable: { !$0.contains("stream URL") },
        willDial: { [weak self] _ in
          guard let self else { return }
          self.dialConfig = self.config
          self.router.setStreamRate(self.dialConfig.streamFrameRate)
        },
        dropped: { [weak self] message in
          // Counted and said once.
          guard let self else { return }
          self.reportStreamError(message)
          self.telemetry.recordStreamDisconnect(message)
          self.streamMegabitsPerSecond = 0
        },
        redialing: { [weak self] in
          guard let self else { return }
          self.telemetry.recordStreamReconnect()
          self.streamErrorGate.reset()
          self.isStreaming = true
        },
        gaveUp: { [weak self] _ in
          guard let self else { return }
          self.isStreaming = false
          self.endLiveSession(streaming: true)
        },
        ended: { [weak self] message in self?.streamEnded(message) }
      ),
      pathMonitor: SystemNetworkPathMonitor()
    )
  }

  /// TeamStation ended this camera (a 410 on a redial): what a deliberate stop does, so the Stream
  /// button starts again and a later relaunch does not resume streaming. The recording carries on.
  private func streamEnded(_ message: String) {
    streamWanted = false
    isStreaming = false
    holdProgrammeSound()
    endLiveSession(streaming: true)
    streamMegabitsPerSecond = 0
    streamDroppedPackets = 0
    telemetry.recordStreamTransport(droppedPackets: 0, queuedBytes: 0)
    telemetry.recordStreamRate(StreamRateTelemetry())
    streamErrorGate.reset()
    reportStreamError(message)
  }

  public func stopStreaming() async {
    streamWanted = false
    liveStartWanted = false
    holdProgrammeSound()
    guard isStreaming || programStreamer.running else {
      // A redial may still be waiting.
      streamSession.stop()
      isStreaming = false
      endLiveSession(streaming: true)
      return
    }
    isStreaming = false
    // Also the failure path: a stream that dropped is a stream that is off, so it is not one the
    // next launch should dial again.
    endLiveSession(streaming: true)
    streamSession.stop()
    streamMegabitsPerSecond = 0
    streamDroppedPackets = 0
    // The poll only records transport health while streaming, so without this the last depth
    // before the stream ended stays in `dump-state` for the rest of the session and reads as a
    // permanent backlog. Measured after a stall: 1013696 bytes, hours after the socket closed.
    telemetry.recordStreamTransport(droppedPackets: 0, queuedBytes: 0)
    telemetry.recordStreamRate(StreamRateTelemetry())
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
      sourceIndex: pipeline.sourceIndex,
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

  /// Gives one camera a writer for the open recording. Callers finish any previous writer first
  /// so the next `AVAssetWriter` can take an audio track.
  ///
  /// Size changes no longer need a new writer: the archive locks the first keyframe's dimensions
  /// and transcodes later pictures. This path remains for a writer that actually failed.
  private func attachArchive(
    to pipeline: SourcePipeline,
    recordingID: Int64,
    previousIncludesAudio: Bool = false
  ) {
    // A camera that has never sent audio must not be given an audio track: the writer waits
    // for audio it will never receive and stops accepting video. Once audio has been seen —
    // this session or on the writer we just closed — the replacement keeps the track.
    let settings = SegmentWriterSettings.from(
      config: config,
      // A camera that sends no audio must not be given an audio track: the segmented writer waits
      // for audio it will never receive and stops accepting video a few seconds in, which the hold
      // filler then bridges with black. That is the burst-then-stall instant replay shows.
      includesAudio: pipeline.hasDeliveredAudio && launch.archiveAudio,
      // One that has not delivered any yet still gets its sound once it does, from the next segment:
      // a camera reconnecting as the recording begins is otherwise silent for the whole take.
      acceptsLateAudio: launch.archiveAudio,
      // Stamped on every segment this writer produces. A take mixes NDI and RTSP now, and the two
      // derive capture time differently enough that "which one wrote this row" is the first
      // question worth asking of an angle that came out in the wrong place.
      transport: discovery?.currentSources
        .first(where: { $0.id == pipeline.sourceID })?.kind.rawValue
    )
    let writer = SegmentWriter(
      sourceID: pipeline.sourceID,
      sourceIndex: pipeline.sourceIndex,
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
      writers[pipeline.sourceID] = writer
      pipeline.setArchive(writer)
      // What this take meant to do with this camera. A camera that is live but writes no segments
      // is otherwise indistinguishable at export from one nobody selected.
      _ = try? index.noteSource(
        recordingID: recordingID,
        sourceID: pipeline.sourceID,
        transport: settings.transport,
        archiving: true,
        cameraName: knownCameraName(for: pipeline.sourceID)
      )
    } catch {
      statusMessage = "\(pipeline.displayName): \(error)"
    }
  }

  private func reopenArchive(for sourceID: SourceID) {
    guard isRecording, let recordingID, let pipeline = router.pipeline(for: sourceID) else { return }
    guard reopeningArchives.insert(sourceID).inserted else { return }
    let previousIncludesAudio = writers[sourceID]?.settings.includesAudio ?? false
    Task { @MainActor in
      defer { reopeningArchives.remove(sourceID) }
      await self.detachAndFinishArchive(for: sourceID)
      guard self.isRecording, let recordingID = self.recordingID else { return }
      self.attachArchive(
        to: pipeline,
        recordingID: recordingID,
        previousIncludesAudio: previousIncludesAudio
      )
    }
  }

  private func detachAndFinishArchive(for sourceID: SourceID) async {
    guard let existing = writers[sourceID] else { return }
    existing.supersede()
    if let pipeline = router.pipeline(for: sourceID) {
      pipeline.setArchive(nil)
    }
    writers[sourceID] = nil
    await existing.finish()
  }

  public func stopRecording() async {
    guard isRecording else { return }
    let endedAt = clock.now
    isRecording = false
    // Before anything is flushed, not after. Stopping takes seconds — writers to finalise, a
    // programme master to close — and a crash in the middle of that would otherwise leave a
    // session still saying the take is live, so the next launch would pick up a take the operator
    // had already stopped. Clearing it first means the worst case is a take closed at its last
    // media by the ordinary sweep, which is what the operator asked for.
    endLiveSession(recording: true)
    // Nothing the programme writes after this instant belongs to the take. Finishing fills it out to
    // the stop, and a live picture arriving during that fill takes its timestamp from it; anchoring
    // those would record the fill's pace as real time.
    programmeRecording.detachAnchors()
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
    // The programme shows each moment a display delay after it happened, so at Stop it has not yet
    // shown the take's last half-second. It keeps recording for that delay, never more than two
    // seconds, so its file reaches the stop and an export can copy it as it is; the take still ends
    // at Stop, where the export cuts it. Flushing the archives above usually took longer already.
    let tail = min(2, max(0, cameras.playout.programMilliseconds / 1_000))
    let waited = clock.now.seconds - endedAt.seconds
    if tail > waited {
      try? await Task.sleep(for: .seconds(tail - waited))
    }
    // The recording's mix waits five seconds for late sound. At Stop it stops waiting and hands the
    // master everything it holds, so the master's sound reaches the end of its picture and Stop
    // takes no longer than it did.
    router.recordingMixer.flush(through: clock.now)
    let programmeRecording = self.programmeRecording
    let programURL = ProgramURL()
    await finishWithDeadline("program", seconds: 45) {
      await programURL.set(programmeRecording.finishProgramme(until: endedAt + tail))
    }
    if let url = await programURL.value {
      let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
      programOutput = url
      telemetry.mutate { $0.dvr.programOutput = "\(url.lastPathComponent) \(bytes ?? 0)" }
    }

    setRecordingStage("closing index")
    // Every part's file on the take's row, the parts written before a crash first, and its end.
    let closing = recordingID
    programmeRecording.close(endedAt: endedAt)
    if closing != nil {
      // The take stopped being live when recording stopped, but only now has an end: without this
      // TS Distributor keeps the length it read before, and counts it up as if still recording.
      distributorEvents.publish(.recordingsChanged)
    }
    lastGridSnapshot = nil
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

  /// Opens or updates the row that says what this app is doing, and starts the heartbeat. Each
  /// beat with nothing live any more closes the session instead.
  private func beginLiveSession(recording: Int64? = nil, streaming: Bool? = nil) {
    programmeRecording.beginLiveSession(recording: recording, streaming: streaming) { [weak self] in
      guard let self else { return false }
      return self.isRecording || self.isStreaming
    }
  }

  /// Clears one half of the live session, and stops the heartbeat once neither is left.
  private func endLiveSession(recording: Bool = false, streaming: Bool = false) {
    programmeRecording.endLiveSession(
      recording: recording,
      streaming: streaming,
      stillLive: isRecording || isStreaming
    )
  }

  private func startRetentionSweeps() {
    retentionTimer?.invalidate()
    retentionTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.sweepRetention() }
    }
  }

  /// Measures free space off the main thread, then sweeps with that reading. The sweep deletes
  /// recordings on it, so it gets a fresh measure rather than the telemetry's cached one. One sweep
  /// at a time: two started on the same low reading would both delete for it.
  public func sweepRetention() {
    guard !retentionSweepInFlight else { return }
    retentionSweepInFlight = true
    Task { @MainActor [weak self] in
      let free = await FreeDiskSpace.shared.measured()
      guard let self else { return }
      self.retentionSweepInFlight = false
      self.sweepRetention(freeDiskBytes: free)
    }
  }

  private func sweepRetention(freeDiskBytes: Int64) {
    guard let sweep = try? retention.sweep(
      maximumArchiveBytes: config.maximumArchiveBytes,
      freeDiskFloorBytes: config.freeDiskFloorBytes,
      protecting: recordingID,
      freeDiskBytes: freeDiskBytes
    ) else { return }
    telemetry.mutate {
      $0.dvr.retentionSwept += UInt64(sweep.removedSegments)
      $0.dvr.retentionReclaimedBytes += UInt64(max(0, sweep.reclaimedBytes))
    }
    if sweep.exhausted {
      // Worth saying out loud: the archive is over budget and the sweeper has nothing left it is
      // allowed to take, so the next thing to run out is the device.
      statusMessage = "Storage low — nothing left to sweep; export and delete old recordings"
    } else if sweep.removedRecordings > 0 {
      let gb = Double(sweep.reclaimedBytes) / 1_073_741_824
      statusMessage = sweep.triggeredByDiskPressure
        ? String(format: "Low storage — freed %.1f GB from %d recording(s)", gb, sweep.removedRecordings)
        : String(format: "Archive full — freed %.1f GB from %d recording(s)", gb, sweep.removedRecordings)
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
  public func beginScrub(sourceIndex: Int) -> Bool {
    guard let pipeline = router.pipeline(at: sourceIndex) else { return false }
    guard availableHistorySeconds(sourceIndex: sourceIndex) > 0 else {
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
  public func updateScrub(sourceIndex: Int, offsetSeconds: Double) {
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }
    let target = (pipeline.liveEdge ?? clock.now) + offsetSeconds
    guard let still = proxyReader.still(for: pipeline.sourceID, at: target),
          let buffer = PixelBufferDrawing.makeBGRA(from: still.image) else { return }
    pipeline.showScrubStill(buffer, offsetSeconds: offsetSeconds)
  }

  public func endScrub(
    sourceIndex: Int,
    offsetSeconds: Double,
    rate: Float = 1,
    playDuration: TimeInterval? = nil
  ) {
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }
    let history = availableHistorySeconds(sourceIndex: sourceIndex)
    guard !ScrubMapping.shouldReturnToLive(
      offsetSeconds: offsetSeconds,
      historySeconds: history
    ) else {
      pipeline.returnToLive()
      applyProgramOverlays()
      return
    }

    playFromArchive(
      sourceIndex: sourceIndex,
      offsetSeconds: offsetSeconds,
      rate: rate,
      playDuration: playDuration
    )
  }

  /// Instant-replay hotkey: switch this camera to program and scrub back `seconds`. Playback
  /// uses the same archive pipeline as finger-up; the hotkey only adds a timed return to live.
  public func startInstantReplay(sourceIndex: Int, seconds: Double, rate: Float) {
    guard seconds > 0 else { return }
    selectProgram(sourceIndex: sourceIndex)
    guard router.pipeline(at: sourceIndex) != nil else { return }
    guard availableHistorySeconds(sourceIndex: sourceIndex) > 0 else {
      statusMessage = isRecording
        ? "Nothing to scrub yet — still building history"
        : "Nothing to scrub — start recording first"
      return
    }
    let history = availableHistorySeconds(sourceIndex: sourceIndex)
    let offset = -min(seconds, max(history, 0))
    playFromArchive(
      sourceIndex: sourceIndex,
      offsetSeconds: offset,
      rate: rate,
      playDuration: seconds
    )
  }

  /// Shared by finger-up and instant-replay hotkeys. Live video keeps moving until the first
  /// decoded archive frame reaches the tile. A single producer then keeps a 2–3 second FIFO
  /// full so display never waits on a file boundary.
  private func playFromArchive(
    sourceIndex: Int,
    offsetSeconds: Double,
    rate: Float,
    playDuration: TimeInterval?
  ) {
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }
    pipeline.beginInstantReplayGeneration()
    applyProgramOverlays()
    // R6 is measured from here — finger-up or hotkey — to the first decoded frame reaching
    // the tile. Timing anything later would flatter the number by excluding assembly.
    let releasedAt = DispatchTime.now().uptimeNanoseconds
    let liveEdge = pipeline.liveEdge ?? clock.now
    let target = liveEdge + offsetSeconds
    let sourceID = pipeline.sourceID
    let epoch = pipeline.currentReplayEpoch
    let frameRate = pipeline.format?.frameRate ?? 30
    Task { [weak self] in
      guard let self else { return }
      let deadline = ContinuousClock.now + .milliseconds(400)
      guard let assembly = await self.assemblePlaylistRetrying(
        sourceID: sourceID,
        from: target,
        to: liveEdge,
        target: target,
        until: deadline
      ) else {
        await MainActor.run {
          guard self.isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch)
          else { return }
          self.statusMessage = "Replay not ready yet — archive still closing"
          self.applyProgramOverlays()
        }
        return
      }
      await self.startReplay(
        sourceIndex: sourceIndex,
        sourceID: sourceID,
        epoch: epoch,
        assembly: assembly,
        target: target,
        offsetSeconds: offsetSeconds,
        frameRate: frameRate,
        rate: rate,
        playDuration: playDuration,
        releasedAt: releasedAt,
        keepLiveOnFailure: true
      )
    }
  }

  private func assemblePlaylistRetrying(
    sourceID: SourceID,
    from: WallClock,
    to: WallClock,
    target: WallClock,
    until deadline: ContinuousClock.Instant
  ) async -> SegmentAssembler.Assembly? {
    let assembler = self.assembler
    var best: SegmentAssembler.Assembly?
    while true {
      let assembled: SegmentAssembler.Assembly? = try? await Task.detached(priority: .userInitiated) {
        try assembler.assemblePlaylist(
          sourceID: sourceID,
          from: from,
          to: to,
          maximumSegments: 64
        )
      }.value
      if let assembly = assembled {
        let startOffset = max(0, target - assembly.startWall)
        if ScrubMapping.shouldStartReplay(
          assemblyDuration: assembly.duration,
          startOffset: startOffset
        ) {
          return assembly
        }
        best = assembly
      }
      if ContinuousClock.now >= deadline { return best }
      try? await Task.sleep(for: .milliseconds(200))
    }
  }

  private func startReplay(
    sourceIndex: Int,
    sourceID: SourceID,
    epoch: UInt64,
    assembly: SegmentAssembler.Assembly,
    target: WallClock,
    offsetSeconds: Double,
    frameRate: Double,
    rate: Float,
    playDuration: TimeInterval?,
    releasedAt: UInt64,
    isContinuation: Bool = false,
    keepLiveOnFailure: Bool = false
  ) async {
    guard isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch) else { return }
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }

    // File-relative: the first assembled sample is t=0 for the decoder, even though fragment
    // PTS is counted from the start of the recording.
    //
    // Walked rather than subtracted. The staged files play back to back, so tape time only advances
    // where a segment exists, while wall clock advances through the gaps too. Subtracting one from
    // the other put the start that much too deep in the tape, ran the replay out early by about the
    // gap, and past a threshold made `shouldStartReplay` refuse a window that was perfectly good.
    let startOffset = assembly.mediaOffset(forWall: target)
    // Read outside the mutation: `availableHistorySeconds` reads the snapshot, and the telemetry lock
    // is not recursive, so calling it inside `mutate` deadlocks the main thread while holding the lock
    // every other thread needs.
    let history = availableHistorySeconds(sourceIndex: sourceIndex)
    let summary = "files=\(assembly.files.count)"
      + " segs=\(assembly.segmentCount)"
      + " dur=\(String(format: "%.2f", assembly.duration))"
      + " startOffset=\(String(format: "%.2f", startOffset))"
      + " offset=\(String(format: "%.2f", offsetSeconds))"
      + " play=\(playDuration.map { String(format: "%.2f", $0) } ?? "nil")"
      + " history=\(String(format: "%.1f", history))"
      + " rate=\(rate)"
      + " cont=\(isContinuation ? 1 : 0)"
    telemetry.mutate { $0.lastReplayAssembly = summary }
    if !ScrubMapping.shouldStartReplay(
      assemblyDuration: assembly.duration,
      startOffset: startOffset
    ) {
      if isContinuation || keepLiveOnFailure {
        if isContinuation { returnToLive(sourceIndex: sourceIndex) }
        else {
          statusMessage = "Replay not ready yet — archive still closing"
          applyProgramOverlays()
        }
        return
      }
      // A playlist that is shorter than the scrub would play for a fraction of a second and
      // snap to live — which is how "rewind never works" looks. Keep the proxy still.
      pipeline.revertToScrubbing()
      statusMessage = "Holding still — archive not ready to replay yet"
      applyProgramOverlays()
      return
    }
    let telemetry = self.telemetry
    let reported = FirstFrameStamp()
    let playedBox = PlayedSeconds()
    let remainingDuration = playDuration
    let holder = ReplayHolder()
    let decoder = ReplayDecoder(
      configuration: .init(
        url: assembly.url,
        startOffset: startOffset,
        frameRate: frameRate,
        port: ReplayDecoder.loopbackPort(forSource: sourceIndex),
        rate: rate,
        playDuration: remainingDuration,
        fileURLs: assembly.files,
        fileDurations: assembly.fileDurations
      ),
      onFrame: { [weak pipeline] buffer, time, played in
        playedBox.store(played)
        if !isContinuation, reported.claim() {
          let elapsed = Double(DispatchTime.now().uptimeNanoseconds - releasedAt) / 1_000_000
          telemetry.mutateTile(sourceIndex) { $0.replayLatencyMilliseconds = elapsed }
        }
        pipeline?.deliverReplayFrame(
          buffer,
          presentationTime: time,
          offsetSeconds: offsetSeconds + played
        )
      },
      onFinish: { [weak self] in
        Task { @MainActor in
          self?.handleReplayEnded(
            sourceIndex: sourceIndex,
            sourceID: sourceID,
            epoch: epoch,
            target: target,
            offsetSeconds: offsetSeconds,
            played: playedBox.load(),
            frameRate: frameRate,
            rate: rate,
            playDuration: remainingDuration,
            releasedAt: releasedAt
          )
        }
      },
      onFailure: { [weak self] error in
        Task { @MainActor in
          guard let self, self.isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch)
          else { return }
          self.telemetry.mutate { $0.lastReplayError = "\(error)" }
          if keepLiveOnFailure {
            self.statusMessage = "Replay failed: \(error)"
            self.returnToLive(sourceIndex: sourceIndex)
          } else {
            self.statusMessage = "Holding still — replay failed: \(error)"
            self.router.pipeline(at: sourceIndex)?.revertToScrubbing()
            self.applyProgramOverlays()
          }
        }
      },
      onNeedsMoreFiles: { [weak self, holder] played in
        guard let decoder = holder.decoder else { return }
        Task { @MainActor in
          await self?.supplyMoreReplayFiles(
            decoder: decoder,
            sourceIndex: sourceIndex,
            sourceID: sourceID,
            epoch: epoch,
            target: target,
            played: played,
            playDuration: remainingDuration
          )
        }
      }
    )
    holder.decoder = decoder

    do {
      try await pipeline.beginReplay(
        decoder,
        offsetSeconds: offsetSeconds,
        stayLiveUntilFirstFrame: keepLiveOnFailure
      )
      guard isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch) else { return }
      statusMessage = nil
      telemetry.mutate { $0.lastReplayError = "" }
      applyProgramOverlays()
    } catch {
      guard isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch) else { return }
      if isContinuation {
        returnToLive(sourceIndex: sourceIndex)
        return
      }
      telemetry.mutate { $0.lastReplayError = "\(error)" }
      if keepLiveOnFailure {
        statusMessage = "Replay failed: \(error)"
        returnToLive(sourceIndex: sourceIndex)
        return
      }
      statusMessage = "Holding still — replay failed: \(error)"
      applyProgramOverlays()
    }
  }

  /// Stages archive files that closed after playback started so the decoder can keep going.
  private func supplyMoreReplayFiles(
    decoder: ReplayDecoder,
    sourceIndex: Int,
    sourceID: SourceID,
    epoch: UInt64,
    target: WallClock,
    played: TimeInterval,
    playDuration: TimeInterval?
  ) async {
    guard isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch) else { return }
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }
    let continueFrom = target + played
    let liveEdge = pipeline.liveEdge ?? clock.now
    let assembler = self.assembler
    let assembled: SegmentAssembler.Assembly?
    do {
      assembled = try await Task.detached(priority: .userInitiated) {
        try assembler.assemblePlaylist(
          sourceID: sourceID,
          from: continueFrom,
          to: liveEdge,
          maximumSegments: 64
        )
      }.value
    } catch {
      assembled = nil
    }
    guard let assembly = assembled, !assembly.files.isEmpty else { return }
    decoder.appendFiles(urls: assembly.files, durations: assembly.fileDurations)
  }

  /// Finger-scrub without a duration keeps going toward live as later files close. A timed
  /// instant replay is one shot: stop at `playDuration` rather than starting a second decoder.
  private func handleReplayEnded(
    sourceIndex: Int,
    sourceID: SourceID,
    epoch: UInt64,
    target: WallClock,
    offsetSeconds: Double,
    played: TimeInterval,
    frameRate: Double,
    rate: Float,
    playDuration: TimeInterval?,
    releasedAt: UInt64
  ) {
    guard isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch) else { return }
    // A timed replay is over when it has shown what was asked for -- not merely when the decoder
    // reaches the end of whatever was staged. The continuation below already carries the remainder
    // and stops itself once the offset reaches live; it was simply unreachable from here.
    if ScrubMapping.hasFinishedTimedReplay(played: played, requested: playDuration) {
      returnToLive(sourceIndex: sourceIndex)
      return
    }
    let currentOffset = offsetSeconds + played
    guard played >= 0.25, ScrubMapping.shouldContinueReplay(currentOffsetSeconds: currentOffset) else {
      returnToLive(sourceIndex: sourceIndex)
      return
    }
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }
    let continueFrom = target + played
    let remaining = playDuration.map { max(0, $0 - played) }
    if let remaining, remaining <= ScrubMapping.snapToLiveSeconds {
      returnToLive(sourceIndex: sourceIndex)
      return
    }
    let liveEdge = pipeline.liveEdge ?? clock.now
    let assembler = self.assembler
    Task { [weak self] in
      let assembly: SegmentAssembler.Assembly
      do {
        assembly = try await Task.detached(priority: .userInitiated) {
          try assembler.assemblePlaylist(
            sourceID: sourceID,
            from: continueFrom,
            to: liveEdge,
            maximumSegments: 64
          )
        }.value
      } catch {
        await MainActor.run {
          guard let self, self.isCurrentReplay(sourceIndex: sourceIndex, sourceID: sourceID, epoch: epoch)
          else { return }
          self.returnToLive(sourceIndex: sourceIndex)
        }
        return
      }
      await self?.startReplay(
        sourceIndex: sourceIndex,
        sourceID: sourceID,
        epoch: epoch,
        assembly: assembly,
        target: continueFrom,
        offsetSeconds: currentOffset,
        frameRate: frameRate,
        rate: rate,
        playDuration: remaining,
        releasedAt: releasedAt,
        isContinuation: true
      )
    }
  }

  public func returnToLive(sourceIndex: Int) {
    router.pipeline(at: sourceIndex)?.returnToLive()
    if router.currentProgramSource == sourceIndex {
      router.programRenderer.prepareForLive()
    }
    applyProgramOverlays()
  }

  /// False when the operator has scrubbed, returned to live, or moved this camera since `epoch`.
  private func isCurrentReplay(sourceIndex: Int, sourceID: SourceID, epoch: UInt64) -> Bool {
    router.pipeline(at: sourceIndex)?.isCurrentReplay(sourceID: sourceID, epoch: epoch) == true
  }

  private static func pngData(_ data: Data) -> Data {
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return data }
    return UIImage(data: data)?.pngData() ?? data
  }

  private func programSourceIsOffLive() -> Bool {
    guard let index = router.currentProgramSource else { return false }
    let state = telemetry.snapshot.tiles.first { $0.index == index }?.state
    return state == .replaying || state == .scrubbing
  }

  private func applyProgramOverlays() {
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
    let source = OverlayComposition.drawable(programOverlays, scoreboardURL: scoreboardContext.url)
    let rects = OverlayLayout.displayRects(
      overlays: source,
      canvas: canvas,
      programIsOffLive: programSourceIsOffLive()
    )
    return source.compactMap { overlay in
      let rect = rects[overlay.id] ?? .zero
      guard rect.width > 0.5, rect.height > 0.5 else { return nil }
      let image: CGImage?
      switch overlay.kind {
      case .web, .scoreboard: image = webSnapshots[overlay.id]?.0
      case .image, .text: image = overlayImages[overlay.id]
      }
      guard let image else { return nil }
      return MetalCompositor.OverlayItem(image: image, origin: rect.origin, size: rect.size)
    }
  }

  /// Overlays burned into Output. Editing another template must not replace the radio-selected one.
  private var programOverlays: [ProgramOverlay] {
    if let editingTemplateID, editingTemplateID != activeTemplateID {
      return templates.first { $0.id == activeTemplateID }?.overlays ?? []
    }
    return overlays
  }

  private func reloadOverlayMedia() {
    for overlay in overlays {
      switch overlay.kind {
      case .web:
        startWebOverlay(overlay)
      case .image:
        loadOverlayImage(overlay)
      case .text:
        rasterizeText(overlay)
      case .scoreboard:
        // The driver decides its page; handed over below.
        break
      }
    }
    updateScoreboards()
  }

  private func startWebOverlay(_ overlay: ProgramOverlay) {
    guard overlay.kind == .web else { return }
    if overlay.url.isEmpty {
      stop(id: overlay.id)
      return
    }
    startWebOverlay(id: overlay.id, urlString: overlay.url)
  }

  /// Loads a page into the overlay's controller, making the controller first
  /// if it has none.
  private func startWebOverlay(id: UUID, urlString: String) {
    pendingWebNative[id] = nil
    let controller: WebOverlayController
    if let existing = webControllers[id] {
      controller = existing
    } else {
      controller = WebOverlayController(size: overlayCanvas)
      controller.onSnapshot = { [weak self] image, size in
        self?.handleWebSnapshot(id: id, image: image, size: size)
      }
      controller.onLoadFailed = { [weak self] in
        self?.scoreboardDriver.loadFailed(id: id)
      }
      webControllers[id] = controller
    }
    controller.load(urlString: urlString)
  }

  // MARK: - Scoreboard content

  /// What decides every scoreboard's page right now.
  private var scoreboardContext: ScoreboardContext {
    ScoreboardContext(
      live: teamStation.chosen.map { teamStation.scoreboardURL(for: $0.gameId) },
      sample: AppServer.url.appending(path: "scoreboard-sample"),
      editorOpen: editingTemplateID != nil,
      capturing: isRecording || isStreaming
    )
  }

  /// Hands the scoreboards being edited and on the programme to the driver,
  /// and redraws the programme without any that resolve to nothing.
  private func updateScoreboards() {
    let programme = programOverlays.filter { overlay in
      !overlays.contains { $0.id == overlay.id }
    }
    scoreboardDriver.update(overlays: overlays + programme, context: scoreboardContext)
    applyProgramOverlays()
  }

  /// The chosen event changes in Settings, on signing out, and when it is
  /// claimed; the scoreboards follow it whichever way it changed.
  private func watchChosenEvent() {
    withObservationTracking {
      _ = teamStation.chosen
    } onChange: { [weak self] in
      Task { @MainActor in
        self?.updateScoreboards()
        self?.followServerClock()
        self?.watchChosenEvent()
      }
    }
  }

  /// Measures the server's clock every minute while a take linked to an event records or streams,
  /// and stops when none does.
  private func followServerClock() {
    serverClock.follow((isRecording || isStreaming) && teamStation.chosen != nil)
  }

  /// Measures the server's clock when somebody signs in, and when a relaunch finds them signed in.
  private func watchSignInForServerClock() {
    let wasSignedIn = teamStation.isSignedIn
    withObservationTracking {
      _ = teamStation.user
    } onChange: { [weak self] in
      Task { @MainActor in
        guard let self else { return }
        if !wasSignedIn, self.teamStation.isSignedIn {
          let clock = self.serverClock
          Task { await clock.measure() }
        }
        self.watchSignInForServerClock()
      }
    }
  }

  /// True while the template being edited has no scoreboard, which is when
  /// one can be added.
  public var canAddScoreboard: Bool {
    !overlays.contains { $0.kind == .scoreboard }
  }

  /// Adds the chosen event's scoreboard to the template being edited.
  public func addScoreboardOverlay() {
    guard
      let next = OverlayTemplate(name: "", overlays: overlays)
        .addingScoreboard(canvas: overlayCanvas)
    else { return }
    overlays = next.overlays
    persistActiveTemplate()
    updateScoreboards()
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
    guard let image, size.width >= 1, size.height >= 1 else {
      webSnapshots[id] = nil
      applyProgramOverlays()
      return
    }
    let applied = fitWebOverlay(id: id, native: size)
    if applied || webSnapshots[id] == nil || snapshotFitsRect(id: id, native: size) {
      webSnapshots[id] = (image, size)
    }
    applyProgramOverlays()
  }

  /// The compositor stretches this bitmap into the overlay's stored rectangle, so a capture whose
  /// aspect ratio disagrees with that rectangle arrives squashed. Those are the captures whose
  /// size was just held back as unproven, so show the last good one until the size is accepted.
  private func snapshotFitsRect(id: UUID, native: CGSize) -> Bool {
    guard
      let overlay = overlays.first(where: { $0.id == id }),
      overlay.width > 0, overlay.height > 0
    else { return true }
    let canvas = overlayCanvas
    return OverlayLayout.aspectsAgree(
      Double(native.width / max(native.height, 1)),
      (overlay.width * Double(canvas.width)) / (overlay.height * Double(canvas.height))
    )
  }

  /// Lays the overlay out from its page's new measure (`OverlayLayout.fitWebSnapshot`).
  ///
  /// Returns whether the overlay was laid out, so the caller knows the new bitmap fits the box.
  @discardableResult
  private func fitWebOverlay(id: UUID, native incoming: CGSize) -> Bool {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return false }
    let fit = OverlayLayout.fitWebSnapshot(
      overlays[index],
      native: incoming,
      canvas: overlayCanvas,
      pending: pendingWebNative[id],
      now: Date()
    )
    pendingWebNative[id] = fit.pending
    guard fit.applied else { return false }
    var next = overlays
    next[index] = fit.overlay
    Self.applyAnchoredChildren(of: id, in: &next, canvas: overlayCanvas)
    // The page's 5 s heartbeat snapshot almost always measures what is already saved. Laid out
    // the same, there is nothing to redraw or save; the bitmap is still accepted.
    guard next != overlays else {
      MainThreadLog.logger.info(
        "overlay manifest save skipped: web overlay laid out unchanged (\(MainThreadLog.threadName, privacy: .public) thread)"
      )
      return true
    }
    overlays = next
    persistActiveTemplate()
    return true
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

  public func addWebOverlay(url: String, showInRewind: Bool = false, showInLive: Bool = true) {
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
      showInRewind: showInRewind,
      showInLive: showInLive
    )
    overlays.append(overlay)
    persistActiveTemplate()
    startWebOverlay(overlay)
    applyProgramOverlays()
  }

  public func addImageOverlay(
    data: Data,
    displayName: String,
    showInRewind: Bool = false,
    showInLive: Bool = true
  ) {
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
      showInRewind: showInRewind,
      showInLive: showInLive
    )
    overlays.append(overlay)
    persistActiveTemplate()
    loadOverlayImage(overlay)
    applyProgramOverlays()
  }

  public func addTextOverlay(showInRewind: Bool = false, showInLive: Bool = true) -> UUID {
    let canvas = overlayCanvas
    let fontSize = max(0.1 * canvas.height, 12)
    let seed = CGRect(
      x: canvas.width / 2,
      y: canvas.height / 2,
      width: 1,
      height: 1
    )
    let overlay = ProgramOverlay(
      kind: .text,
      originX: Double(seed.origin.x / canvas.width),
      originY: Double(seed.origin.y / canvas.height),
      width: 0.05,
      height: 0.08,
      placement: .centerQuarter,
      hasLaidOut: true,
      showInRewind: showInRewind,
      showInLive: showInLive,
      text: "",
      fontSize: fontSize,
      textAlign: .center,
      hugText: true
    )
    overlays.append(overlay)
    if let index = overlays.firstIndex(where: { $0.id == overlay.id }) {
      layoutAndRasterizeText(at: index)
    }
    persistActiveTemplate()
    return overlay.id
  }

  public func beginEditingTextOverlay(id: UUID) {
    guard overlays.contains(where: { $0.id == id && $0.kind == .text }) else { return }
    editingTextOverlayID = id
  }

  public func endEditingTextOverlay() {
    if let id = editingTextOverlayID,
       let overlay = overlays.first(where: { $0.id == id }),
       overlay.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      editingTextOverlayID = nil
      removeOverlay(id: id)
      return
    }
    editingTextOverlayID = nil
  }

  public func updateTextOverlay(
    id: UUID,
    text: String? = nil,
    fontName: String? = nil,
    fontSize: Double? = nil,
    isBold: Bool? = nil,
    isItalic: Bool? = nil,
    textAlign: TextOverlayAlign? = nil,
    hugText: Bool? = nil,
    textColorHex: String? = nil,
    dropShadowEnabled: Bool? = nil,
    dropShadowColorHex: String? = nil
  ) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    if let text { overlays[index].text = text }
    if let fontName { overlays[index].fontName = fontName }
    if let fontSize { overlays[index].fontSize = min(max(fontSize, 6), 200) }
    if let isBold { overlays[index].isBold = isBold }
    if let isItalic { overlays[index].isItalic = isItalic }
    if let textAlign { overlays[index].textAlign = textAlign }
    if let hugText { overlays[index].hugText = hugText }
    if let textColorHex { overlays[index].textColorHex = textColorHex }
    if let dropShadowEnabled { overlays[index].dropShadowEnabled = dropShadowEnabled }
    if let dropShadowColorHex { overlays[index].dropShadowColorHex = dropShadowColorHex }
    layoutAndRasterizeText(at: index)
    persistActiveTemplate()
  }

  private func layoutAndRasterizeText(at index: Int) {
    guard overlays[index].kind == .text else { return }
    let canvas = overlayCanvas
    if overlays[index].hugText {
      let measured = TextOverlayRenderer.measure(overlay: overlays[index], canvas: canvas)
      let current = OverlayLayout.pixelRect(overlays[index], canvas: canvas)
      let rect = OverlayLayout.huggedTextRect(
        align: overlays[index].textAlign,
        current: current,
        textSize: measured,
        canvas: canvas
      )
      let normalized = OverlayLayout.normalized(rect, canvas: canvas)
      overlays[index].originX = normalized.originX
      overlays[index].originY = normalized.originY
      overlays[index].width = normalized.width
      overlays[index].height = normalized.height
    }
    rasterizeText(overlays[index])
    applyProgramOverlays()
  }

  private func rasterizeText(_ overlay: ProgramOverlay) {
    guard overlay.kind == .text else { return }
    overlayImages[overlay.id] = TextOverlayRenderer.makeImage(
      overlay: overlay,
      canvas: overlayCanvas
    )
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
    let canvas = overlayCanvas
    let current = OverlayLayout.pixelRect(overlays[index], canvas: canvas)
    let oldNative: CGSize
    if overlays[index].nativeWidth > 0 {
      oldNative = CGSize(width: overlays[index].nativeWidth, height: overlays[index].nativeHeight)
    } else if let old = overlayImages[id] {
      oldNative = CGSize(width: old.width, height: old.height)
    } else {
      oldNative = .zero
    }
    guard let newImage = UIImage(data: data)?.cgImage else {
      persistActiveTemplate()
      loadOverlayImage(overlays[index])
      applyProgramOverlays()
      return
    }
    let newNative = CGSize(width: newImage.width, height: newImage.height)
    let rect = OverlayLayout.replacedImageRect(
      origin: current.origin,
      currentSize: current.size,
      oldNative: oldNative,
      newNative: newNative,
      canvas: canvas
    )
    let normalized = OverlayLayout.normalized(rect, canvas: canvas)
    overlays[index].originX = normalized.originX
    overlays[index].originY = normalized.originY
    overlays[index].width = normalized.width
    overlays[index].height = normalized.height
    overlays[index].nativeWidth = Double(newNative.width)
    overlays[index].nativeHeight = Double(newNative.height)
    overlays[index].hasLaidOut = true
    overlayImages[id] = newImage
    persistActiveTemplate()
    applyProgramOverlays()
  }

  public func setOverlayShowInRewind(id: UUID, showInRewind: Bool) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    overlays[index].showInRewind = showInRewind
    persistActiveTemplate()
    applyProgramOverlays()
  }

  public func setOverlayShowInLive(id: UUID, showInLive: Bool) {
    guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
    overlays[index].showInLive = showInLive
    persistActiveTemplate()
    applyProgramOverlays()
  }

  public func overlayPreviewImage(for overlay: ProgramOverlay) -> CGImage? {
    switch overlay.kind {
    case .image:
      return overlayImages[overlay.id]
    case .web, .scoreboard:
      return webSnapshots[overlay.id]?.0
    case .text:
      return overlayImages[overlay.id]
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
    if overlays[index].kind.isWebBacked {
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
    overlays[index] = OverlayLayout.applyResize(
      overlays[index],
      to: CGRect(x: originX, y: originY, width: width, height: height),
      canvas: overlayCanvas
    )
    if overlays[index].kind.isWebBacked, overlays[index].nativeWidth >= 1 {
      applyAnchoredChildren(of: id)
    }
    if overlays[index].kind == .text {
      rasterizeText(overlays[index])
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
    pendingWebNative[id] = nil
    overlayImages[id] = nil
    if overlay.kind == .image {
      overlayStore.removeImage(filename: overlay.imageFilename)
    }
    updateScoreboards()
  }

  public func beginEditingTemplate(id: UUID) {
    persistWorkingTemplate()
    guard templates.contains(where: { $0.id == id }) else { return }
    editingTemplateID = id
    overlays = templates.first(where: { $0.id == id })?.overlays ?? []
    reloadOverlayMedia()
  }

  public func endEditingTemplate() {
    persistWorkingTemplate()
    editingTemplateID = nil
    editingTextOverlayID = nil
    overlays = templates.first(where: { $0.id == activeTemplateID })?.overlays ?? []
    stopUnusedOverlayMedia()
    reloadOverlayMedia()
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
    if overlay.kind.isWebBacked {
      return Self.topLeftSquare(image)
    }
    return UIImage(cgImage: image)
  }

  private func apply(_ manifest: OverlayManifest) {
    templates = manifest.templates
    activeTemplateID = manifest.activeTemplateID
    overlays = templates.first(where: { $0.id == activeTemplateID })?.overlays ?? []
  }

  private func persistWorkingTemplate() {
    let targetID = editingTemplateID ?? activeTemplateID
    if let index = templates.firstIndex(where: { $0.id == targetID }) {
      // Reassigned only when different: every assignment redraws whatever lists templates.
      if templates[index].overlays != overlays {
        templates[index].overlays = overlays
      }
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

  private func persistActiveTemplate() {
    persistWorkingTemplate()
  }

  private func apply(_ manifest: RemoteControlManifest) {
    remoteTemplates = manifest.templates
    activeRemoteTemplateID = manifest.activeTemplateID
  }

  private func persistActiveRemoteTemplate() {
    remoteStore.save(
      RemoteControlManifest(templates: remoteTemplates, activeTemplateID: activeRemoteTemplateID)
    )
  }

  public var activeRemoteTemplate: RemoteControlTemplate? {
    remoteTemplates.first { $0.id == activeRemoteTemplateID }
  }

  public var editingRemoteTemplate: RemoteControlTemplate? {
    remoteTemplates.first { $0.id == (editingRemoteTemplateID ?? activeRemoteTemplateID) }
  }

  public func beginEditingRemoteTemplate(id: UUID) {
    persistActiveRemoteTemplate()
    guard remoteTemplates.contains(where: { $0.id == id }) else { return }
    editingRemoteTemplateID = id
  }

  public func endEditingRemoteTemplate() {
    persistActiveRemoteTemplate()
    editingRemoteTemplateID = nil
  }

  private var mutatingRemoteTemplateID: UUID {
    editingRemoteTemplateID ?? activeRemoteTemplateID
  }

  public func selectRemoteTemplate(id: UUID) {
    persistActiveRemoteTemplate()
    guard remoteTemplates.contains(where: { $0.id == id }) else { return }
    activeRemoteTemplateID = id
    persistActiveRemoteTemplate()
  }

  public func renameRemoteTemplate(id: UUID, name: String) {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    persistActiveRemoteTemplate()
    guard let index = remoteTemplates.firstIndex(where: { $0.id == id }) else { return }
    remoteTemplates[index].name = trimmed
    persistActiveRemoteTemplate()
  }

  public func createRemoteTemplate(name: String) -> UUID? {
    persistActiveRemoteTemplate()
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let template = RemoteControlTemplate(id: UUID(), name: trimmed)
    remoteTemplates.append(template)
    activeRemoteTemplateID = template.id
    persistActiveRemoteTemplate()
    return template.id
  }

  public func duplicateRemoteTemplate(from sourceID: UUID, name: String) -> UUID? {
    persistActiveRemoteTemplate()
    guard let source = remoteTemplates.first(where: { $0.id == sourceID }) else { return nil }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let template = RemoteControlTemplate(
      id: UUID(),
      name: trimmed,
      remoteType: source.remoteType,
      bindings: source.bindings,
      lastSeenProductName: source.lastSeenProductName
    )
    remoteTemplates.append(template)
    activeRemoteTemplateID = template.id
    persistActiveRemoteTemplate()
    return template.id
  }

  public func deleteRemoteTemplate(id: UUID) {
    persistActiveRemoteTemplate()
    guard let index = remoteTemplates.firstIndex(where: { $0.id == id }) else { return }
    if remoteTemplates.count == 1 {
      apply(RemoteControlManifest.emptyDefault())
    } else {
      remoteTemplates.remove(at: index)
      if activeRemoteTemplateID == id {
        activeRemoteTemplateID = remoteTemplates[min(index, remoteTemplates.count - 1)].id
      }
    }
    persistActiveRemoteTemplate()
  }

  public func setRemoteType(_ type: RemoteType, for id: UUID) {
    persistActiveRemoteTemplate()
    guard let index = remoteTemplates.firstIndex(where: { $0.id == id }) else { return }
    let fit = RemoteChordRules.bestFit(bindings: remoteTemplates[index].bindings, to: type)
    remoteTemplates[index].remoteType = type
    remoteTemplates[index].bindings = fit.kept
    persistActiveRemoteTemplate()
  }

  public func appendRemoteControl(_ id: ControlID, to action: RemoteAction) {
    persistActiveRemoteTemplate()
    guard let index = remoteTemplates.firstIndex(where: { $0.id == mutatingRemoteTemplateID }) else {
      return
    }
    RemoteChordRules.capture(id, for: action, in: &remoteTemplates[index].bindings)
    persistActiveRemoteTemplate()
  }

  public func clearRemoteChord(for action: RemoteAction) {
    persistActiveRemoteTemplate()
    guard let index = remoteTemplates.firstIndex(where: { $0.id == mutatingRemoteTemplateID }) else {
      return
    }
    RemoteChordRules.clear(action: action, in: &remoteTemplates[index].bindings)
    persistActiveRemoteTemplate()
  }

  public func bindRemoteAction(_ action: RemoteAction, controls: [ControlID]) {
    persistActiveRemoteTemplate()
    guard let index = remoteTemplates.firstIndex(where: { $0.id == mutatingRemoteTemplateID }) else {
      return
    }
    RemoteChordRules.bind(action, controls: controls, in: &remoteTemplates[index].bindings)
    persistActiveRemoteTemplate()
  }

  public func cutSourceLive(sourceIndex: Int) {
    guard router.pipeline(at: sourceIndex) != nil else { return }
    selectProgram(sourceIndex: sourceIndex)
    returnToLive(sourceIndex: sourceIndex)
  }

  private func handleRemoteDown(_ id: ControlID, pressed: Set<ControlID>) {
    if capturingRemoteAction != nil {
      appendRemoteControl(id, to: capturingRemoteAction!)
      return
    }
    guard activeSheet == nil else { return }
    guard let template = activeRemoteTemplate else { return }
    guard let action = RemoteChordRules.match(pressed: pressed, bindings: template.bindings) else {
      return
    }
    guard template.chord(for: action).set.contains(id) else { return }
    performRemote(action)
  }

  public func injectRemoteChord(_ ids: [ControlID]) {
    remoteInput.inject(chord: ids)
  }

  private func performRemote(_ action: RemoteAction) {
    switch action {
    case let .cutLive(sourceIndex):
      cutSourceLive(sourceIndex: sourceIndex)
    case let .instantReplay(sourceIndex, seconds, speed):
      guard let pipeline = router.pipeline(at: sourceIndex) else { return }
      guard pipeline.currentState == .live else { return }
      let rate: Float = speed == .slow ? Float(config.replaySlowMotionRate) : 1
      startInstantReplay(sourceIndex: sourceIndex, seconds: seconds, rate: rate)
    }
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
    var ids = Set(overlays.map(\.id))
    if let editingTemplateID, editingTemplateID != activeTemplateID {
      if let active = templates.first(where: { $0.id == activeTemplateID }) {
        ids.formUnion(active.overlays.map(\.id))
      }
    }
    for id in webControllers.keys where !ids.contains(id) {
      webControllers[id]?.stop()
      webControllers[id] = nil
      webSnapshots[id] = nil
      pendingWebNative[id] = nil
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
    Self.applyAnchoredChildren(of: parentID, in: &overlays, canvas: overlayCanvas)
  }

  private static func applyAnchoredChildren(
    of parentID: UUID,
    in overlays: inout [ProgramOverlay],
    canvas: CGSize
  ) {
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
      applyAnchoredChildren(of: overlays[i].id, in: &overlays, canvas: canvas)
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
      for parent in overlays where parent.kind.isWebBacked && parent.id != child.id {
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
  public func availableHistorySeconds(sourceIndex: Int) -> Double {
    guard isRecording, let pipeline = router.pipeline(at: sourceIndex) else { return 0 }
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
    let renamed = newConfig.cameraName != persistedConfig.cameraName
    persistedConfig = newConfig
    configStore.save(newConfig)
    var session = Self.applying(launch, to: newConfig)
    session.replaySlowMotionRate = AppConfig.clampedReplaySlowMotionRate(session.replaySlowMotionRate)
    // Launch `-debugHUD` is a one-time overlay. Saving Settings must be able to hide the HUD.
    session.showDebugHUD = newConfig.showDebugHUD
    let sweptSubnetChanged = config.activeScanSubnets != session.activeScanSubnets
    config = session
    let fallbackEncoding = session.takeEncoding
    exportFallbackEncoding.withLock { $0 = fallbackEncoding }
    applyDisplayLatencyCap()
    SubnetScanner.setOverrideSubnets(networkAddresses: session.activeScanSubnets)
    // A new subnet to sweep should be looked at now, not whenever the next sweep comes due.
    if sweptSubnetChanged {
      discovery?.sweepNow()
      eventControl.subnetsChanged()
    }
    eventControl.setEnabled(session.eventControlEnabled)
    // A new camera name renames the stream this Director holds, keeping its key and its video.
    if renamed, session.streamDestination == .event {
      let name = session.cameraName
      Task { await eventCoordinator.cameraRenamed(to: name) }
    }
    if wantsSimulated != sessionIsSimulated {
      Task { await applySourceProfile(SourceProfile.forSimulatedCameras(wantsSimulated)) }
    }
  }

  /// Launch arguments overlay the running session and are forgotten when the process exits.
  /// Writing them back is how a test flag became a saved setting, so they never touch disk.
  static func applying(_ launch: LaunchConfiguration, to config: AppConfig) -> AppConfig {
    var config = config
    if let seconds = launch.segmentSeconds { config.segmentSeconds = seconds }
    if let codec = launch.programCodec { config.programCodec = codec }
    if let hud = launch.debugHUD { config.showDebugHUD = hud }
    if let url = launch.streamURL {
      config.streamURL = url
      // A run that names a URL streams there. Left on `event`, the stream went to whatever game
      // Settings had chosen, which can be a real team's.
      if !url.isEmpty { config.streamDestination = .url }
    }
    if let bitrate = launch.programBitrate { config.programBitrate = bitrate }
    if let rate = launch.programFrameRate { config.programFrameRate = rate }
    if let codec = launch.streamCodec { config.streamCodec = codec }
    if let resolution = launch.streamResolution { config.streamResolution = resolution }
    if let rate = launch.streamFrameRate { config.streamFrameRate = rate }
    if launch.streamBitrateLow != nil || launch.streamBitrateHigh != nil {
      let range = AppConfig.clampedStreamBitrates(
        low: launch.streamBitrateLow ?? config.streamBitrateLow,
        high: launch.streamBitrateHigh ?? config.streamBitrateHigh
      )
      config.streamBitrateLow = range.low
      config.streamBitrateHigh = range.high
    }
    if let cap = launch.displayLatencyCapMilliseconds {
      config.displayLatencyCapEnabled = cap > 0
      if cap > 0 { config.displayLatencyCapMilliseconds = AppConfig.clampedDisplayLatencyCap(cap) }
    }
    if let cap = launch.diskLatencyCapMilliseconds {
      config.diskLatencyCapEnabled = cap > 0
      if cap > 0 { config.diskLatencyCapMilliseconds = AppConfig.clampedDiskLatencyCap(cap) }
    }
    if let seconds = launch.resumeDowntimeLimitSeconds {
      config.resumeDowntimeLimitSeconds = seconds
    }
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
    // Never past D, cap on or off: a picture held longer reaches the programme after its moment.
    cameras.playout.setCap(milliseconds: TileRouter.playoutCapMilliseconds(
      capEnabled: config.displayLatencyCapEnabled,
      capMilliseconds: config.displayLatencyCapMilliseconds
    ))
    // Two different things share the word latency. The line above bounds how much delay the
    // delay line *adds* to smooth jitter; this bounds how old a picture may be and still be shown
    // or still be kept. Nothing enforced the second before, on either transport, which is how a
    // tile came to display frames two seconds behind the room.
    router.setLatencyCaps(FrameLatencyGate.Caps(config: config))
    // The live mix plays each camera's sound this long after capture: the same cap.
    router.setLiveSoundDelay(seconds: TileRouter.liveSoundDelaySeconds(
      capEnabled: config.displayLatencyCapEnabled,
      capMilliseconds: config.displayLatencyCapMilliseconds
    ))
  }

  public func setDiskLatencyCapMilliseconds(_ milliseconds: Double) {
    var next = persistedConfig
    next.diskLatencyCapEnabled = true
    next.diskLatencyCapMilliseconds = AppConfig.clampedDiskLatencyCap(milliseconds)
    update(config: next)
  }

  public func setDiskLatencyCapEnabled(_ enabled: Bool) {
    var next = persistedConfig
    next.diskLatencyCapEnabled = enabled
    if enabled, next.diskLatencyCapMilliseconds <= 0 {
      next.diskLatencyCapMilliseconds = AppConfig.diskLatencyCapDefaultMilliseconds
    }
    update(config: next)
  }

  public func export(sourceIndex: Int, lastSeconds: Double) {
    guard let pipeline = router.pipeline(at: sourceIndex) else { return }
    let end = pipeline.liveEdge ?? clock.now
    let sourceID = pipeline.sourceID
    let displayName = pipeline.displayName
    let exporter = self.exporter
    Task {
      do {
        let result = try await exporter.export(
          sourceID: sourceID,
          displayName: displayName,
          from: end - lastSeconds,
          to: end
        )
        await MainActor.run {
          self.lastExport = result
          self.statusMessage = "Exported \(result.url.lastPathComponent)"
        }
      } catch {
        await MainActor.run {
          self.statusMessage = "Export failed: \(error)"
        }
      }
    }
  }

  /// The take currently being written, if any. Recordings refuses to select or delete it.
  public var activeRecordingID: Int64? { isRecording ? recordingID : nil }

  public func listedRecordings() -> [RecordingSummary] {
    (try? index.recordings()) ?? []
  }

  public func deleteRecordings(ids: [Int64]) {
    do {
      try index.deleteRecordings(ids: ids, skipping: activeRecordingID)
    } catch {
      statusMessage = "Delete failed: \(error)"
    }
    distributorEvents.publish(.recordingsChanged)
  }

  public func recordingCameraName(for sourceID: SourceID) -> String {
    knownCameraName(for: sourceID) ?? sourceID.rawValue
  }

  /// A recorded camera's name: what the take stored for it, else what it is called now. A camera
  /// the Director has since forgotten keeps the name it recorded under instead of showing its id.
  public func recordingCameraName(for sourceID: SourceID, in recordingID: Int64) -> String {
    if let recorded = try? index.recordedCameraNames(recordingID: recordingID)[sourceID] {
      return recorded
    }
    return recordingCameraName(for: sourceID)
  }

  /// What the operator calls a camera right now, or nil when it has nothing but its id.
  private func knownCameraName(for sourceID: SourceID) -> String? {
    if let selection = selections.first(where: { $0.id == sourceID }) {
      return selection.displayName
    }
    return cameraRecords.first(where: { SourceID($0.id.uuidString) == sourceID })?.name
  }

  /// Keeps the live take's record of a camera's name current when it is renamed mid-take.
  private func noteRenameInLiveTake(_ sourceID: SourceID) {
    guard isRecording, let recordingID, let name = knownCameraName(for: sourceID) else { return }
    try? index.nameSource(recordingID: recordingID, sourceID: sourceID, cameraName: name)
  }

  public func shareRecording(
    _ recording: RecordingSummary,
    cameras: [(SourceID, String)],
    includeProgram: Bool,
    reprocess: Bool = false
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
          try await exporter.exportRecording(
            recording,
            cameras: cameraList,
            includeProgram: includeProgram,
            reprocess: reprocess,
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

  /**
   Exports a recording the way the share button does, and sends the files to a
   game on TeamStation instead of to a share sheet.

   The selection is the operator's own — the programme, a camera, several —
   because upload is that choice sent somewhere else rather than a second
   differently-shaped choice. Every file goes to the same game; the first is
   the one that takes the live stream's place, and the rest arrive beside it.
   */
  public func uploadRecording(
    _ recording: RecordingSummary,
    cameras: [(SourceID, String)],
    includeProgram: Bool,
    gameId: String,
    title: String
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
          try await exporter.exportRecording(
            recording,
            cameras: cameraList,
            includeProgram: includeProgram,
            reprocess: false,
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
        await MainActor.run { self?.isExporting = false }
        guard let self else { return }
        guard !urls.isEmpty else {
          await MainActor.run { self.statusMessage = "Nothing to upload for that recording" }
          return
        }
        // What each file is, in the order `exportRecording` writes them: the
        // programme first where it was asked for, then the cameras as given.
        // Taken from the request rather than from the file names, which carry
        // the take's date and not the camera — reading those named a camera
        // `2026-09-20-12-16-49` and gave the library a video to match.
        var labels: [(kind: String, suffix: String)] = []
        if includeProgram && recording.programFilename != nil {
          // The primary output carries **no** suffix. That is how the library
          // tells it from the cameras: the one upload with nothing added.
          labels.append((kind: "program", suffix: ""))
        }
        for camera in cameraList { labels.append((kind: camera.name, suffix: " \(camera.name)")) }

        guard labels.count == urls.count else {
          await MainActor.run {
            self.statusMessage = "Exported \(urls.count) files for \(labels.count) tracks; not uploading"
          }
          return
        }

        for (url, label) in zip(urls, labels) {
          let videoId = await self.teamStation.upload(
            file: url,
            recordingID: recording.id,
            gameId: gameId,
            title: title + label.suffix,
            kind: label.kind,
            // The take's own wall clock, which every file of the export
            // starts at — `ExportWindow` begins at `recording.startedAt` and
            // each track is padded to it. The same instant for every file,
            // whatever order they go up in and however long each takes.
            startedAt: recording.startedAt.date,
            // How far the server's clock was from this iPad's during the take, which the
            // server adds to that start so the video sits on its clock with the scoring.
            serverClockOffsetMs: recording.serverClockOffsetMs
          )
          if videoId == nil { break }
        }
        await MainActor.run {
          self.statusMessage = self.teamStation.uploads[recording.id]?.failed
            ?? "Uploaded to TeamStation"
        }
      } catch {
        await MainActor.run {
          self?.isExporting = false
          self?.statusMessage = "Export failed: \(error)"
        }
      }
    }
  }

  public func hasPreparedExport(
    _ recording: RecordingSummary,
    cameras: [(SourceID, String)],
    includeProgram: Bool
  ) -> Bool {
    exporter.hasPreparedExport(
      recording,
      cameras: cameras.map { (sourceID: $0.0, name: $0.1) },
      includeProgram: includeProgram
    )
  }

  /// Remux the most recent stopped take into Prepared/. Does not present the share sheet.
  private func beginPreparedExport(reprocess: Bool = false) {
    guard !isExporting else { return }
    guard let recording = listedRecordings().first(where: { $0.endedAt != nil }) else {
      telemetry.mutate { $0.dvr.lastExportError = "no stopped recording" }
      return
    }
    isExporting = true
    telemetry.mutate {
      $0.dvr.isExporting = true
      $0.dvr.lastExportRecordingID = recording.id
      $0.dvr.lastExportFiles = []
      $0.dvr.lastExportError = nil
    }
    let cameras = recording.sourceIDs.map { ($0, recordingCameraName(for: $0, in: recording.id)) }
    let includeProgram = recording.programFilename != nil
    let exporter = self.exporter
    Task { [weak self] in
      do {
        let urls = try await Task.detached(priority: .userInitiated) {
          try await exporter.exportRecording(
            recording,
            cameras: cameras.map { (sourceID: $0.0, name: $0.1) },
            includeProgram: includeProgram,
            reprocess: reprocess
          )
        }.value
        await MainActor.run {
          guard let self else { return }
          self.isExporting = false
          self.lastRecordingShare = urls
          self.telemetry.mutate {
            $0.dvr.isExporting = false
            $0.dvr.lastExportFiles = urls.map(\.lastPathComponent)
            $0.dvr.lastExportError = urls.isEmpty ? "nothing to export" : nil
          }
        }
      } catch {
        await MainActor.run {
          guard let self else { return }
          self.isExporting = false
          self.telemetry.mutate {
            $0.dvr.isExporting = false
            $0.dvr.lastExportError = String(describing: error)
          }
        }
      }
    }
  }

  public func runEncodeProbe(
    upTo maximum: Int = 8,
    framesPerSession: Int = 1,
    width: Int = 1920,
    height: Int = 1080,
    frameRate: Int = 30
  ) {
    let result = EncodeSessionProbe.probe(
      upTo: maximum,
      width: width,
      height: height,
      framesPerSession: framesPerSession,
      frameRate: frameRate
    )
    probeResult = result
    statusMessage = result.summary
    telemetry.mutate { $0.encodeProbe = result.summary }
  }

  /// Off the main actor: this one deliberately runs for tens of seconds.
  public func runThroughputProbe(
    sessions: Int,
    seconds: Double,
    height: Int,
    hevc: Bool,
    frameRate: Int = 30
  ) {
    statusMessage = "Measuring sustained encode throughput…"
    telemetry.mutate { $0.encodeProbe = "throughput probe running…" }
    Task.detached(priority: .userInitiated) { [telemetry] in
      let result = EncodeSessionProbe.sustainedThroughput(
        sessions: sessions,
        seconds: seconds,
        width: height * 16 / 9,
        height: height,
        codec: hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
        frameRate: frameRate
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
    pollInterval = 0
    schedulePollTimer(Self.livePollInterval)
    startAnnouncedFrameRateRefresh()
  }

  /// Asks each TS Cameraman on the board what frame rate it is set to, every so often, so replay
  /// pacing and the delay line run on the phone's own number rather than one measured from its
  /// timestamps. See `CameraFrameRateQuery`.
  @ObservationIgnored private var announcedRateTask: Task<Void, Never>?
  private static let announcedRateInterval: Duration = .seconds(15)

  private func startAnnouncedFrameRateRefresh() {
    guard announcedRateTask == nil else { return }
    announcedRateTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshAnnouncedFrameRates()
        try? await Task.sleep(for: Self.announcedRateInterval)
      }
    }
  }

  private func refreshAnnouncedFrameRates() async {
    for pipeline in router.activePipelines {
      guard controlAdvertisement(for: pipeline.sourceID)?.isControllable == true,
            let endpoint = controlEndpoint(for: pipeline.sourceID)
      else { continue }
      // A phone that misses one query keeps the rate it gave last time.
      if let rate = await CameraFrameRateQuery.frameRate(
        host: endpoint.host,
        port: endpoint.port,
        path: endpoint.path
      ) {
        pipeline.setAnnouncedFrameRate(rate)
      }
    }
  }

  private func schedulePollTimer(_ interval: TimeInterval) {
    guard interval != pollInterval else { return }
    pollInterval = interval
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.pollTelemetry() }
    }
  }

  private func pollTelemetry() {
    syncCameraTelemetry()
    recordCameraControlTelemetry()
    telemetry.recordConverter(converter.currentStatistics)
    let status = statusMessage ?? ""
    let cpu = ProcessLoad.cpuPercent()
    let summaries = selections.enumerated().map { offset, selection in
      SourceSummary(
        index: offset + 1,
        name: selection.displayName,
        isEnabled: selection.isEnabled,
        usesAudio: selection.usesAudio,
        inputGain: selection.inputGain,
        isPresent: selection.isPresent,
        sourceIndex: selection.sourceIndex,
        endpointHost: endpoint(for: selection.id)?.host,
        advertisedHost: cameraAdvertisement(for: selection.id)?.host,
        controlVersion: cameraAdvertisement(for: selection.id)?.controlVersion,
        linkedControlIndex: selection.linkedControlID.flatMap { control in
          selections.firstIndex { $0.id == control }.map { $0 + 1 }
        },
        isLinkedControl: SourceSelectionRules.isLinkedControl(selection.id, in: selections)
      )
    }
    let mix = router.audioMixer.currentStatistics
    let recordingMix = router.recordingMixer.currentStatistics
    let overlayStatus = webControllers.values.map(\.status).joined(separator: " ")
    let composedFrames = compositor?.frameCount ?? 0
    let discoveryStatus = discovery?.diagnostic ?? ""
    let displayLatency = cameras.playout.programMilliseconds
    // Tell discovery what is at stake, so its fallback sweep can decide whether to run at all.
    // An enabled camera the finder cannot currently see is the whole trigger: during a recording
    // there is no sweep until one goes missing, and none once it is back.
    // Missing means "not usable", not merely "not listed". A camera can be present in discovery
    // and silent — which is how tonight's dropout looked, and a sweep that waited for the
    // discovery list to change would never have started.
    let silent = Set(
      telemetry.snapshot.tiles.filter { $0.stalledForSeconds > 0 }.compactMap(\.sourceID)
    )
    let missing = selections.contains {
      $0.isEnabled && (!$0.isPresent || silent.contains($0.id.rawValue))
    }
    eventControl.setBusy(self.isRecording || self.isStreaming)
    discovery?.setSweepDemand(
      isBusy: self.isRecording || self.isStreaming,
      anyEnabledCameraMissing: missing,
      // The camera list is the one screen whose whole purpose is finding cameras, so it is the one
      // place a sweep is what the operator asked for rather than something done to them.
      isBrowsing: self.activeSheet == .cameras
    )
    telemetry.mutate {
      $0.statusMessage = status
      $0.sources = summaries
      $0.overlay = overlayStatus
      $0.audioMixContributors = mix.contributors
      $0.audioMixSeconds = (mix.emittedSeconds * 10).rounded() / 10
      $0.audioMixLateBuffers = mix.lateBuffers
      $0.audioMixFutureBuffers = mix.futureBuffers
      $0.recordingMixSeconds = (recordingMix.emittedSeconds * 10).rounded() / 10
      $0.recordingMixLateBuffers = recordingMix.lateBuffers
      $0.recordingMixFutureBuffers = recordingMix.futureBuffers
      $0.liveSoundDelayMilliseconds = (mix.readLagSeconds * 1_000).rounded()
      let pictures = self.router.programmePictureCounts
      let ticks = self.router.programmeTickStatistics()
      $0.programmeTickLatenessMaxMilliseconds = (ticks.latenessMax * 10_000).rounded() / 10
      $0.programmeMissedTicks = ticks.missed
      $0.programmeLatePictures = pictures.late
      $0.programmeSkippedPictures = pictures.skipped
      $0.programmeComposeMisses = self.router.programmeComposeMisses
      $0.audioMixFades = mix.fades
      $0.audioMixConcealedSeconds = (mix.concealedSeconds * 100).rounded() / 100
      $0.recordingMixFades = recordingMix.fades
      $0.recordingMixConcealedSeconds = (recordingMix.concealedSeconds * 100).rounded() / 100
      $0.cpuPercent = (cpu * 10).rounded() / 10
      $0.cpuCores = ProcessLoad.coreCount
      $0.availableMemoryMB = ProcessLoad.availableMemoryMB()
      $0.physFootprintMB = ProcessLoad.physFootprintMB()
      // Re-read rather than cached: a device that roams between networks gets a new lease, and a
      // stale answer here is worse than none when the question is which link to condition.
      $0.localAddresses = LocalAddresses.ipv4()
      $0.residentSizeMB = ProcessLoad.residentSizeMB()
      $0.discoveryStatus = discoveryStatus
      $0.eventControl = self.eventControl.telemetry
      $0.displayLatencyMilliseconds = displayLatency
      let caps = FrameLatencyGate.Caps(config: config)
      $0.displayLatencyCapMilliseconds = (caps.displaySeconds ?? 0) * 1_000
      $0.diskLatencyCapMilliseconds = (caps.diskSeconds ?? 0) * 1_000
      $0.programAudioPlaying = self.router.audioPlayer.isRunning
      $0.isStreaming = self.isStreaming
      $0.streamDestination = self.config.streamDestination.rawValue
      $0.streamTarget = self.streamTargetDescription
      $0.keepAliveInBackground = self.shouldKeepAliveInBackground
      $0.pictureInPictureActive = self.pictureInPicture.isActive
      $0.sourceLayout = self.sourceLayout.displayOrder
      $0.outputCorner = self.sourceLayout.programCorner.rawValue
    }
    telemetry.recordComposedFrames(composedFrames)
    let sound = router.soundStatus()
    for index in SourceIndex.all.map(\.value) {
      telemetry.mutateTile(index) { tile in
        guard let status = sound[index] else {
          tile.soundState = ""
          return
        }
        tile.soundState = status.live?.phase.rawValue ?? "silent"
        tile.soundHeldMilliseconds = (status.heldSeconds * 1_000).rounded()
        tile.soundFades = status.live?.fades ?? 0
        tile.soundConcealedMilliseconds = ((status.live?.concealedSeconds ?? 0) * 1_000).rounded()
        tile.soundTimelines = status.timeline.timelines
        tile.soundSessionTimelines = status.timeline.sessionTimelines
        tile.soundLargestStepMilliseconds = (status.timeline.largestStepSeconds * 10_000).rounded() / 10
        tile.soundSteps = status.timeline.steps
        tile.soundReanchors = status.timeline.reanchors
        tile.soundDriftPartsPerMillion = (status.timeline.driftPartsPerMillion * 10).rounded() / 10
        tile.soundGaps = status.timeline.gaps
        tile.soundErrorMilliseconds = (status.timeline.lastErrorSeconds * 10_000).rounded() / 10
      }
    }
    var liveDecodeSessions = 0
    var countedBytesPerSecond = 0.0
    var uncountedTiles: [Int] = []
    for pipeline in router.activePipelines {
      let format = pipeline.format
      let connections = pipeline.connections
      let receive = pipeline.receiveStats
      liveDecodeSessions += receive.decodeSessions
      telemetry.recordPacketsLost(tile: pipeline.sourceIndex, cumulative: receive.packetsLost)
      if let bytes = receive.bytesReceived {
        countedBytesPerSecond += telemetry.recordReceivedBytes(tile: pipeline.sourceIndex, cumulative: bytes)
      } else {
        uncountedTiles.append(pipeline.sourceIndex)
      }
      telemetry.mutateTile(pipeline.sourceIndex) { tile in
        tile.sourceWidth = format?.width ?? 0
        tile.sourceHeight = format?.height ?? 0
        tile.sourceFrameRate = format?.frameRate ?? 0
        tile.sourceCodec = format?.codecName ?? ""
        tile.sourcePixelFormat = format.map { SourceFormat.fourCharacterCode($0.pixelFormat) } ?? ""
        tile.connections = connections
        tile.capturedFrames = receive.captured
        tile.poolMisses = receive.poolMisses
        tile.formatMisses = receive.formatMisses
        tile.sourceStatus = receive.status ?? ""
        let elapsed = receive.waitingSeconds + receive.deliverySeconds
        tile.receiveWaitFraction = elapsed > 0 ? receive.waitingSeconds / elapsed : 0
        tile.deliveryMilliseconds = receive.captured > 0
          ? (receive.deliverySeconds / Double(receive.captured)) * 1000
          : 0
        tile.copyMilliseconds = receive.copyMilliseconds
        tile.publishMilliseconds = receive.publishMilliseconds
        tile.archiveEncoded = receive.archiveEncoded
        tile.archiveKeyframes = receive.archiveKeyframes
        tile.archiveEncodeRefused = receive.archiveEncodeRefused
        tile.archiveEncoderRebuilds = receive.archiveEncoderRebuilds
        tile.archiveEncodeStatus = receive.archiveEncodeStatus
        tile.decodeFailures = receive.decodeFailures
        tile.decoderRebuilds = receive.decoderRebuilds
        tile.decodeStatus = receive.decodeStatus
        tile.reconnects = receive.reconnects
        tile.archiveDropped = receive.archiveDropped
        tile.archiveBacklog = receive.archiveBacklog
        tile.archiveStride = receive.archiveStride
        tile.archiveRepeatedTicks = receive.archiveRepeatedTicks
        tile.archiveSkippedPictures = receive.archiveSkippedPictures
        tile.archiveLatePictures = receive.archiveLatePictures
        tile.arrivalGapMaxMilliseconds = receive.arrivalGapMaxMilliseconds
        tile.arrivalGapWasKeyframe = receive.arrivalGapWasKeyframe
        tile.deliverMaxMilliseconds = receive.deliverMaxMilliseconds
        tile.pacingSpreadMilliseconds = receive.pacingSpreadMilliseconds
        tile.releaseGapMaxMilliseconds = receive.releaseGapMaxMilliseconds
        tile.playoutMilliseconds = receive.playoutMilliseconds
        tile.playoutLateFrames = receive.playoutLateFrames
        tile.playoutDepth = receive.playoutDepth
        tile.codedPicturesTrimmed = receive.codedPicturesTrimmed
        tile.decodedPicturesTrimmed = receive.decodedPicturesTrimmed
        tile.outOfOrderFrames = receive.outOfOrderFrames
        tile.senderClockRestarts = receive.senderClockRestarts
        tile.stalledForSeconds = (receive.stalledForSeconds * 10).rounded() / 10
        tile.senderReports = receive.senderReports
        tile.senderReportIntervalSeconds = receive.senderReportIntervalSeconds
        tile.senderReportAgeSeconds = receive.senderReportAgeSeconds
        tile.senderReportStreams = receive.senderReportStreams
        tile.mediaTicksPerSecond = receive.mediaTicksPerSecond
        tile.mediaClockSpanSeconds = receive.mediaClockSpanSeconds
        tile.cameraClockOffsetSeconds = receive.cameraClockOffsetSeconds
        tile.cameraClockOffsetFilteredSeconds = receive.cameraClockOffsetFilteredSeconds
        tile.cameraClockOffsetSamples = receive.cameraClockOffsetSamples
        tile.cameraClockSteps = receive.cameraClockSteps
        tile.soundAwaitingClock = receive.soundAwaitingClock
        tile.correctedCaptureTime = receive.correctedCaptureTime
        tile.correctedCaptureAgeMilliseconds = receive.correctedCaptureAgeMilliseconds
        tile.captureFromSenderFrames = receive.captureFromSenderFrames
        tile.captureFromArrivalFrames = receive.captureFromArrivalFrames
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

    // An NDI camera's bytes never pass through us, so its share is inferred: everything Wi-Fi
    // received less what the RTSP cameras counted. Only honest with one such camera; with two,
    // there is no telling how to split the remainder, so neither claims it.
    if let raw = LocalAddresses.wifiReceivedBytes() {
      let interfaceRate = wifiReceiveRate.record(
        wifiReceivedBytes.extend(raw),
        at: ProcessInfo.processInfo.systemUptime
      )
      for tile in uncountedTiles {
        telemetry.setReceiveRate(
          tile: tile,
          bytesPerSecond: uncountedTiles.count == 1 ? max(0, interfaceRate - countedBytesPerSecond) : nil
        )
      }
    }

    // The acceptance number, computed once every camera's tile has been written this pass.
    //
    // Individual per-camera delays can all look dreadful while the output is perfectly aligned —
    // that is the design working — so this is what an alarm belongs on. Cameras still inside their
    // sender-report grace window carry no corrected time and are left out rather than contributing
    // a zero, which would read as a spread of the whole epoch.
    telemetry.mutate {
      // Within a few seconds of now, not merely positive. A camera whose anchor is stale or not yet
      // established produces a capture time that is arbitrarily wrong rather than absent, and one
      // of those admitted into the set reports a spread of hours — which is worse than reporting
      // nothing, because it looks like a measurement.
      let now = Date().timeIntervalSince1970
      let corrected = $0.tiles.filter {
        $0.state == .live && abs(now - $0.correctedCaptureTime) < 10
      }
      guard corrected.count >= 2 else {
        $0.captureSpreadMilliseconds = 0
        $0.captureSpreadWorstCamera = ""
        return
      }
      let times = corrected.map { $0.correctedCaptureTime }
      $0.captureSpreadMilliseconds = (((times.max() ?? 0) - (times.min() ?? 0)) * 1000).rounded()
      $0.captureSpreadWorstCamera = corrected
        .min(by: { $0.correctedCaptureTime < $1.correctedCaptureTime })?
        .displayName ?? ""
    }
    telemetry.recordLiveDecodeSessions(liveDecodeSessions)
    let next = telemetry.snapshot
    let replaying = showsReplayOffset(snapshot) || showsReplayOffset(next)
    schedulePollTimer(replaying ? Self.replayPollInterval : Self.livePollInterval)
    if shouldPublishSnapshotToUI(next) {
      snapshot = next
      lastPublishedUIAt = clock.now.seconds
      if isStreaming {
        if liveStartWanted, let started = programStreamer.liveTimelineStart {
          liveStartWanted = false
          let destination = dialConfig.streamDestination
          let serverClock = self.serverClock
          Task {
            // On the server's clock, measured against the steady wall clock the start is read on;
            // an iPad's own is usually right, but not always. Unmeasured, nothing is said, and the
            // server places the video by when it heard it.
            var measured = serverClock.offsetMs
            if measured == nil { measured = await serverClock.measure()?.offsetMs }
            guard let offsetMs = measured else { return }
            await eventCoordinator.liveStarted(
              at: started.date.addingTimeInterval(Double(offsetMs) / 1000),
              destination: destination
            )
          }
        }
        let stream = streamSession.refreshCongestion()
        streamMegabitsPerSecond = stream.megabitsPerSecond
        streamDroppedPackets = stream.droppedPackets
        // Into telemetry as well as the HUD, so `dump-state` and the soak scripts can see a
        // stalled uplink. A stall that shows zero drops is the shape of the 2026-09-05 crash.
        telemetry.recordStreamTransport(
          droppedPackets: stream.droppedPackets,
          queuedBytes: stream.queuedBytes
        )
        telemetry.recordStreamRate(stream.rate)
      }
    }
    applyProgramOverlays()
    takeTelemetry.note(recording: activeRecordingID, snapshot: next, at: clock.now.seconds)
  }

  /// HUD numbers can wait a second. The yellow replay-offset pill cannot — it should tick about
  /// every twentieth of a second while any tile is replaying or scrubbing. Tile *state* (live vs
  /// replay, who is on air) still publishes immediately, or Maestro waits on a stale nameplate.
  private func shouldPublishSnapshotToUI(_ next: TelemetrySnapshot) -> Bool {
    let interval = showsReplayOffset(snapshot) || showsReplayOffset(next)
      ? Self.replayUIPublishInterval
      : Self.liveUIPublishInterval
    if clock.now.seconds - lastPublishedUIAt >= interval {
      return true
    }
    if snapshot.dvr.isRecording != next.dvr.isRecording { return true }
    if snapshot.isStreaming != next.isStreaming { return true }
    if snapshot.programSource != next.programSource { return true }
    if snapshot.statusMessage != next.statusMessage { return true }
    if snapshot.tiles.map(\.state) != next.tiles.map(\.state) { return true }
    if snapshot.tiles.map(\.displayName) != next.tiles.map(\.displayName) { return true }
    if snapshot.tiles.map(\.isProgram) != next.tiles.map(\.isProgram) { return true }
    return false
  }

  private func showsReplayOffset(_ snap: TelemetrySnapshot) -> Bool {
    snap.tiles.contains { $0.state == .replaying || $0.state == .scrubbing }
  }

  // MARK: - Control channel

  /// `tsdirector://` commands. Ignored unless the app was launched with `uiTest` (D7), so the
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
      // Overlay the encoder settings on the running session without touching Settings on disk,
      // so a soak can change bitrate between blocks. `ProgramStreamer` reads these when it
      // starts, so the stream has to be stopped and started for a change to take effect.
      if let bitrate = launch.programBitrate { config.programBitrate = bitrate }
      if let rate = launch.programFrameRate { config.programFrameRate = rate }
      if let url = launch.streamURL { config.streamURL = url }
      config = Self.applying(launch, to: config)
      applyDisplayLatencyCap()
      if launch.useTestClock, testClock == nil { statusMessage = "Test clock requires relaunch" }
      if let profile = launch.sourceProfile {
        Task { await applySourceProfile(profile) }
      } else {
        startDiscovery()
      }
    case let .setSlowMotionRate(percent):
      // Session only. Writing this through `update(config:)` saved a test's rate over whatever the
      // operator had chosen, which is exactly what the launch-configuration comment warns against:
      // a flow should neither inherit nor leave behind a preference.
      config.replaySlowMotionRate = AppConfig.clampedReplaySlowMotionRate(percent / 100)

    case let .scrub(source, offset):
      beginScrub(sourceIndex: source)
      updateScrub(sourceIndex: source, offsetSeconds: offset)
      endScrub(sourceIndex: source, offsetSeconds: offset)
    case let .returnToLive(source):
      returnToLive(sourceIndex: source)
    case let .record(on):
      if on { startRecording() } else { Task { await stopRecording() } }
    case let .stream(on):
      if on { startStreaming() } else { Task { await stopStreaming() } }
    case .startDirecting:
      Task { await enterDirecting() }
    case let .selectProgram(source):
      selectProgram(sourceIndex: source)
    case let .selectAudioSource(source):
      // By grid slot, like `.selectProgram`, so a flow names a camera the same way for both.
      guard let pipeline = router.pipeline(at: source) else { return false }
      setUsesAudio(true, for: pipeline.sourceID)
    case let .replay(source, seconds, speed):
      let rate: Float = speed == "slow" ? Float(config.replaySlowMotionRate) : 1
      startInstantReplay(sourceIndex: source, seconds: seconds, rate: rate)
    case let .assignSource(index, slot):
      guard index >= 0, index < selections.count else { return false }
      assignSource(slot: slot, to: selections[index].id)
    case let .remoteChord(names):
      let ids = names.compactMap { ControlID(rawValue: $0) }
      guard !ids.isEmpty else { return false }
      injectRemoteChord(ids)
    case let .bindRemote(actionID, names):
      guard let action = RemoteAction.parseControl(actionID) else { return false }
      bindRemoteAction(action, controls: names.compactMap { ControlID(rawValue: $0) })
    case let .cameraControl(source, open):
      if open {
        guard isCameramanControllable(sourceIndex: source) else { return false }
        openCameraControl(sourceIndex: source)
      } else {
        closeCameraControl()
      }
    case let .enableSource(index, on):
      guard index >= 0, index < selections.count else { return false }
      setEnabled(on, for: selections[index].id)
    case let .sourceAudio(index, on):
      guard index >= 0, index < selections.count else { return false }
      setUsesAudio(on, for: selections[index].id)
    case let .digitalZoom(source, zoom):
      guard let pipeline = router.pipeline(at: source) else { return false }
      setDigitalZoom(zoom, for: pipeline.sourceID)
    case let .sourceGain(index, gain):
      guard index >= 0, index < selections.count else { return false }
      setInputGain(gain, for: selections[index].id)
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
    case let .linkSource(video, control):
      guard video >= 0, video < selections.count, control >= 0, control < selections.count else { return false }
      return linkSource(video: selections[video].id, control: selections[control].id) == .linked
    case let .unlinkSource(index):
      guard index >= 0, index < selections.count else { return false }
      let id = selections[index].id
      if isLinkedControl(id) { unlinkSource(control: id) } else { unlinkSource(video: id) }
    case .searchCameras:
      discovery?.sweepNow()
      discovery?.searchNow()
    case let .setDisplayLatencyCap(milliseconds):
      // Saved, as the Performance sheet saves it; a launch or /configure cap overlays it for a session.
      if milliseconds > 0 {
        setDisplayLatencyCapMilliseconds(milliseconds)
      } else {
        setDisplayLatencyCap(enabled: false)
      }
    case let .setSubnetScan(subnet, on):
      // Through `update(config:)`, like the Settings switch it stands in for, so a bench set up this
      // way is still set up after a relaunch. The subnets named are swept in addition to the local
      // one. Turning it on without a usable subnet is refused rather than quietly saved as on
      // with nothing added.
      var next = persistedConfig
      if let subnet { next.subnetScanOverride = subnet }
      if let on { next.subnetScanOverrideEnabled = on }
      guard !next.subnetScanOverrideEnabled || !next.activeScanSubnets.isEmpty else { return false }
      update(config: next)
    case let .advanceClock(seconds):
      testClock?.advance(by: seconds)
      sweepRetention()
    case let .probeEncoders(maximum, framesPerSession, width, height, fps):
      runEncodeProbe(
        upTo: maximum,
        framesPerSession: framesPerSession,
        width: width,
        height: height,
        frameRate: fps
      )
    case let .probeThroughput(sessions, seconds, height, hevc, fps):
      runThroughputProbe(
        sessions: sessions,
        seconds: seconds,
        height: height,
        hevc: hevc,
        frameRate: fps
      )
    case let .probeWriter(options):
      runWriterProbe(options: options)
    case .dumpState:
      pollTelemetry()
      stateDumper.dump(telemetry.snapshot)
    case .reset:
      telemetry.reset()
      testClock?.reset()
      statusMessage = nil
    case let .sourceLayout(order, corner):
      setSourceLayout(SourceLayout(
        order: order,
        programCorner: corner.flatMap(ProgramCorner.init(rawValue:)) ?? sourceLayout.programCorner
      ))
    case .killProgramWriter:
      programEncoder.poisonWriter()
    case let .exportRecording(reprocess):
      beginPreparedExport(reprocess: reprocess)
    case .crash:
      // SIGKILL, so nothing runs on the way out: no scene callbacks, no writer finalise, no stop
      // path. Anything gentler tests the code that already works.
      kill(getpid(), SIGKILL)
    }
    return true
  }

  /// Same commands over loopback HTTP. `dump-state` answers with the snapshot inline so a
  /// script does not have to reach into the app container to read it.
  private func handleFromControlServer(url: URL) -> Data? {
    guard handle(url: url) else { return nil }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .prettyPrinted, .sortedKeys ]
    if ControlChannel.command(from: url) == .dumpState, let data = try? encoder.encode(telemetry.snapshot) {
      return data
    }
    return Data(#"{"ok":true}"#.utf8)
  }

  // MARK: - TS Distributor

  /// Starts the server TS Distributor reaches over the cable. It listens on loopback, where usbmuxd
  /// delivers the Mac's connections, so nothing on the Wi-Fi can reach it.
  private func startLinkServer() {
    guard linkServer == nil else { return }
    let service = distributorService
    let server = LinkServer(connectionsChanged: { [weak self] count in
      Task { @MainActor in
        self?.isMacConnected = count > 0
        // A Mac that went away mid-export cannot hand the lock back.
        if count == 0 {
          self?.exportLease.releaseAll()
          self?.clearExportRefusal()
        }
      }
    }) { await service.handle($0) }
    linkServer = server
    Task { [weak self] in
      // A restart can find the port still held by the listener it replaced for a moment.
      for attempt in 1...3 {
        do {
          try await server.start()
          return
        } catch {
          guard let self, linkServer === server else { return }
          if attempt == 3 {
            linkServer = nil
            statusMessage = "TS Distributor link unavailable: \(error.localizedDescription)"
            return
          }
          try? await Task.sleep(for: .milliseconds(300))
        }
      }
    }
  }

  private func stopLinkServer() {
    guard let server = linkServer else { return }
    distributorEvents.publish(.directorBackgrounded)
    server.stop()
    linkServer = nil
    isMacConnected = false
    exportLease.releaseAll()
  }

  /// TS Distributor starts an export: refused while recording or streaming, and from here until it
  /// ends neither can start. One Mac at a time; a new export replaces an old one's lease.
  func beginDistributorExport() throws -> UUID {
    if isRecording { throw DistributorRefusal.recording }
    if isStreaming { throw DistributorRefusal.streaming }
    let id = exportLease.grant()
    watchExportLease()
    return id
  }

  func renewDistributorExport(_ id: UUID) -> Bool {
    exportLease.renew(id)
  }

  func endDistributorExport(_ id: UUID) {
    exportLease.release(id)
    clearExportRefusal()
  }

  /// A "record once it has finished" banner outliving the export would say something no longer
  /// true.
  private func clearExportRefusal() {
    guard !exportLease.isHeld, statusMessage?.hasPrefix("TS Distributor is exporting") == true else { return }
    statusMessage = nil
  }

  /// Drops the lease if the Mac stops renewing it, so a Mac that crashed or hung mid-export never
  /// leaves the Director unable to record.
  private func watchExportLease() {
    guard exportLeaseWatch == nil else { return }
    exportLeaseWatch = Task { [weak self] in
      while let self, exportLease.isHeld {
        try? await Task.sleep(for: .seconds(5))
        if exportLease.expire() {
          statusMessage = "TS Distributor stopped answering — recording and streaming are allowed again"
        }
      }
      self?.exportLeaseWatch = nil
    }
  }

  private func restartLinkServer() {
    linkServer?.stop()
    linkServer = nil
    startLinkServer()
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

/// The pages of web-rendered overlays run here, in `webControllers`, so the
/// scoreboard driver's pages are seen by the same teardown, sweep and status
/// as every other web overlay's.
extension AppEnvironment: WebOverlayHosting {
  public func start(id: UUID, url: URL) {
    startWebOverlay(id: id, urlString: url.absoluteString)
  }

  public func load(id: UUID, url: URL) {
    webControllers[id]?.load(urlString: url.absoluteString)
  }

  public func stop(id: UUID) {
    webControllers[id]?.stop()
    webControllers[id] = nil
    webSnapshots[id] = nil
    pendingWebNative[id] = nil
  }

  public func isRunning(id: UUID) -> Bool {
    webControllers[id] != nil
  }
}
