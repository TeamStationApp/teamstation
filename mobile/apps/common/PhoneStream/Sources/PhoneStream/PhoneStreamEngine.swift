import AVFoundation
import CameramanCapture
import CameramanCore
import DirectorCore
import DirectorExport
import DirectorMedia
import DirectorSources
import Foundation
import TeamStationKit
import UIKit

/// The zoom rail the overlay draws: its pills, where the lenses hand over, and where the camera's
/// own range ends and digital zoom begins, all in displayed units.
public struct PhoneZoomScale: Sendable, Equatable {
  public var presets: [Double]
  public var switchOvers: [Double]
  /// Where digital zoom starts, nil when the camera has none.
  public var digitalFrom: Double?
  public var minimum: Double
  public var maximum: Double
  public var current: Double
}

/// One lens of the Lenses card, and whether the operator may turn it off.
public struct PhoneLens: Sendable, Equatable {
  public var lens: CameraLens
  public var enabled: Bool
  public var canDisable: Bool
}

/**
 * The phone's streaming and recording engine: TS Director's pipeline from the phone's camera.
 *
 * - `open` starts the capture and the programme; the preview draws straight from the capture
 *   session (`previewSession`), without the programme's picture delay. `close` ends them.
 * - `startRecording` starts two things from the same programme tick: a `RecordingSession`, whose
 *   take carries the game, the angle and the live stream and is written by `ProgramEncoder` at
 *   6 Mbps, and a `StreamSessionController`, which publishes `ProgramStreamer` to the URL and puts it
 *   back when it drops. JS asked for the stream with an explicit start, so the first dial uses the
 *   URL as given; every redial asks again with the stream this device holds, and a 410 stops the
 *   stream (`streamEnded`) while the recording carries on.
 * - One recording per live stream: Record on a stream whose take has not been uploaded continues
 *   that take as its next part, at any distance in time. While a take's upload is running or cut off,
 *   Record on its stream throws `uploadInProgress`, so no part is ever added after the export being
 *   sent was made.
 * - Going to the background ends capture: the heartbeat stops, the part is finished and the stream
 *   drops. Back in the foreground, or after a kill when the streaming screen is opened again within
 *   the hour, `LiveSessionResume` continues the take as its next part, timed from its first picture,
 *   and the stream redials.
 * - A take finishes its part cleanly when free space falls under 500 MB, and the stream goes on.
 * - `uploadRecording` exports the take's programme (placed by wall clock across parts) and sends it
 *   with `UploadService`, keeping the upload id on the take so a killed upload resumes. The export
 *   starts at part 1's first picture, and its `startAt` is when that picture was captured.
 * - Once a session's first publish has sent a picture, TeamStation is told when that picture was
 *   captured (`reportLiveStart`), which is where it places the stream's live video.
 */
@MainActor
public final class PhoneStreamEngine {
  /// The process's engine, with the app's own storage, camera and network.
  public static let shared: PhoneStreamEngine = {
    do {
      return try PhoneStreamEngine(environment: .live())
    } catch {
      fatalError("PhoneStream could not open its catalog: \(error)")
    }
  }()

  public let environment: PhoneStreamEnvironment
  public let index: ArchiveIndex
  public let catalog: PhoneCatalog
  public let telemetry = PhoneMediaTelemetry()
  public let radar: PhoneRadar
  let encoder: ProgramEncoder
  let streamer: ProgramStreamer
  let programme: PhoneProgramme
  let recordingSession: RecordingSession
  private(set) var streamController: StreamSessionController!
  private let store: SQLiteStore
  private let converter = PixelConverter()
  private let deviceStatus: any PhoneDeviceStatusReading

  /// The stream on the air, and what its redial needs.
  private struct StreamTake {
    var liveStreamId: String
    var gameId: String
    var angleName: String
    var request: PhoneStreamRequest
    var recordingID: Int64?
    /// The URL the first `.start` dial uses as given.
    var firstURL: String?
    /// The last URL the server gave, for a redial the server cannot answer.
    var cachedURL: String?
  }

  public private(set) var isOpen = false
  public private(set) var angleName = ""
  public private(set) var audioEnabled = true
  private var source: PhoneCameraSource?
  private var cameraState = CameraSession.State()
  /// A restart of a capture that stopped on a runtime error, waiting to run.
  private var captureRestart: Task<Void, Never>?
  /// How many times the capture has been started again after a runtime error.
  public private(set) var captureRestarts = 0
  private var captureSettings = CameramanCore.StreamSettings()
  private var pinchStartDeviceZoom: Double?
  private var stream: StreamTake?
  /// The take a part is being written for, nil between parts.
  private var recordingTakeID: Int64?
  /// A part finished by the background, waiting for the foreground to continue it.
  private var suspendedInBackground = false
  private var lastError: PhoneStreamError?
  /// A part being finished: its hold fill and its writer's close take a second or more.
  private var finishing: Task<Void, Never>?
  /// Set as a session starts streaming, until TeamStation has been told when its first published
  /// picture was captured; see `reportLiveStartIfReady`.
  private var liveStartWanted = false
  /// The report of the live start, while it is being sent.
  private(set) var liveStartReport: Task<Void, Never>?
  private var statusLoop: Task<Void, Never>?
  private var storageLoop: Task<Void, Never>?
  private var observers: [UUID: (PhoneStreamEvent) -> Void] = [:]
  private var applicationObservers: [any NSObjectProtocol] = []

  /// Uploads running in this process, by take.
  private var uploads: [Int64: Task<String, Error>] = [:]
  /// What each running upload was started with, so a cancel can abandon it on the server.
  private var uploadServers: [Int64: (server: URL, token: String)] = [:]

  public init(environment: PhoneStreamEnvironment) throws {
    self.environment = environment
    try environment.storage.prepare()
    store = try SQLiteStore(url: environment.storage.index)
    index = try ArchiveIndex(store: store)
    catalog = try PhoneCatalog(store: store, index: index)
    encoder = ProgramEncoder(
      telemetry: telemetry,
      converter: converter,
      settings: PhoneStreamProfile.programmeSettings,
      directory: environment.storage.program,
      clock: environment.clock
    )
    streamer = ProgramStreamer(telemetry: telemetry, converter: converter, clock: environment.clock)
    programme = PhoneProgramme(recording: encoder, stream: streamer, clock: environment.clock)
    recordingSession = RecordingSession(
      index: index,
      encoder: encoder,
      clock: environment.clock,
      heartbeatInterval: environment.heartbeatInterval
    )
    deviceStatus = environment.makeDeviceStatus()
    radar = PhoneRadar(fleet: environment.makeRadarFleet())
    streamController = StreamSessionController(
      publisher: streamer,
      host: StreamSessionController.Host(
        requestURL: { [weak self] reason in
          guard let self else { throw CancellationError() }
          return try await self.streamURL(for: reason)
        },
        settings: { PhoneStreamProfile.streamSettings },
        gaveUp: { [weak self] _ in self?.fail(.streamFailed) },
        ended: { [weak self] _ in self?.fail(.streamEnded) }
      ),
      scheduler: environment.makeRetryScheduler(),
      pathMonitor: environment.makePathMonitor(),
      stallRedialSeconds: PhoneStreamProfile.stallRedialSeconds
    )
    radar.onChange = { [weak self] state in self?.emit(.radar(state)) }
    if environment.observesApplication { observeApplication() }
  }

  // MARK: - Events

  /// Calls `handler` with every status, radar and upload event until the observation is cancelled
  /// or released.
  public func observe(_ handler: @escaping (PhoneStreamEvent) -> Void) -> PhoneStreamObservation {
    let id = UUID()
    observers[id] = handler
    return PhoneStreamObservation { [weak self] in
      Task { @MainActor in self?.observers[id] = nil }
    }
  }

  /// The same events as a stream, for a host that reads them in a loop.
  public func events() -> AsyncStream<PhoneStreamEvent> {
    let (events, continuation) = AsyncStream<PhoneStreamEvent>.makeStream()
    let observation = observe { continuation.yield($0) }
    continuation.onTermination = { _ in observation.cancel() }
    return events
  }

  private func emit(_ event: PhoneStreamEvent) {
    for handler in observers.values { handler(event) }
  }

  private func fail(_ error: PhoneStreamError) {
    lastError = error
    publishStatus()
  }

  // MARK: - Open and close

  /// The capture session the preview layer draws, nil before `open` and on a simulator.
  public var previewSession: AVCaptureSession? { source?.device?.previewSession }

  /// Starts the camera, the preview and the programme. On an open engine, applies the arguments.
  public func open(angleName: String, audioEnabled: Bool = true, disabledLenses: Set<String> = []) throws {
    self.angleName = angleName
    setAudioEnabled(audioEnabled)
    guard !isOpen else {
      setDisabledLenses(disabledLenses)
      return
    }
    captureSettings = CameramanCore.StreamSettings(
      width: PhoneStreamProfile.resolution.width,
      height: PhoneStreamProfile.resolution.height,
      frameRate: Double(PhoneStreamProfile.frameRate),
      codec: .hevc,
      audioEnabled: true,
      disabledLensIDs: disabledLenses
    )
    let source = environment.makeSource()
    if let device = source.device {
      device.onStateChange = { [weak self] state in self?.cameraChanged(state) }
      device.configure(position: .back, settings: captureSettings)
    }
    programme.start()
    programme.setSoundEnabled(audioEnabled)
    let programme = self.programme
    try source.start(sinks: FrameSinks(
      pixel: { programme.add(picture: $0) },
      audio: { programme.add(sound: $0) }
    ))
    self.source = source
    isOpen = true
    radar.start()
    startStatusLoop()
    _ = try? environment.retention.sweep(
      catalog: catalog,
      index: index,
      storage: environment.storage,
      now: environment.clock.now
    )
  }

  /// Ends the capture and the programme, stopping a recording first.
  public func close() async {
    guard isOpen else { return }
    if stream != nil { await stopRecording() }
    statusLoop?.cancel()
    statusLoop = nil
    captureRestart?.cancel()
    captureRestart = nil
    source?.stop()
    source = nil
    programme.stop()
    isOpen = false
    publishStatus()
  }

  // MARK: - A capture that stops on its own

  /// How long a capture stopped by a runtime error waits before it is started again.
  static let captureRestartDelaySeconds = 0.3

  /// Whether the camera stopped on a runtime error, rather than because it was closed or the
  /// system took it away (an interruption, which AVFoundation ends by itself).
  static func stoppedOnError(_ state: CameraSession.State) -> Bool {
    !state.isRunning && !state.isInterrupted && state.failure?.hasPrefix("runtimeError") == true
  }

  /// Each change of the camera's state. A capture that stops on a runtime error is started again
  /// while the engine is open, so the preview and the programme carry on.
  ///
  /// Changing a connection's rotation rebuilds the capture graph, microphone included. When the
  /// app's audio session has meanwhile been set to a category without input, which the host's
  /// video player does whenever the category changes, that rebuild fails with a runtime error and
  /// `AVCaptureSession` stops: the preview and the stream then hold their last picture for good.
  /// Starting it again is what AVFoundation asks of a runtime error, and puts the input back.
  private func cameraChanged(_ state: CameraSession.State) {
    cameraState = state
    guard isOpen, captureRestart == nil, Self.stoppedOnError(state),
      let device = source?.device
    else { return }
    captureRestart = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.captureRestartDelaySeconds))
      guard !Task.isCancelled, let self else { return }
      self.captureRestart = nil
      guard self.isOpen, self.source?.device === device, Self.stoppedOnError(self.cameraState) else { return }
      self.captureRestarts += 1
      device.start()
    }
  }

  public func setAngleName(_ name: String) {
    angleName = name
  }

  // MARK: - Recording and streaming

  /// Starts the recording and the stream from the same programme tick.
  public func startRecording(
    rtmpUrl: String,
    liveStreamId: String,
    gameId: String,
    angleName: String,
    request: PhoneStreamRequest
  ) throws {
    guard isOpen, stream == nil, finishing == nil else { throw PhoneStreamError.notReady }
    let existing = try catalog.current(forLiveStream: liveStreamId)
    if existing?.hasPendingUpload == true { throw PhoneStreamError.uploadInProgress }
    guard environment.storageRules.canStart(freeBytes: environment.freeDiskBytes()) else {
      fail(.insufficientStorage)
      throw PhoneStreamError.insufficientStorage
    }
    // A take another stream left open when the app stopped is over: it ends where it got to.
    if let live = try catalog.live(), live.liveStreamId != liveStreamId {
      closeInterruptedTake()
    }
    self.angleName = angleName
    lastError = nil
    let now = environment.clock.now
    let settings = PhoneStreamProfile.recordingSettings
    let recordingID: Int64
    programme.setFeedsRecording(true)
    do {
      if let existing {
        try catalog.reopen(existing.recordingID)
        let take = LiveSessionResume.Take(
          recordingID: existing.recordingID,
          startedAt: existing.startedAt,
          selections: nil,
          programSource: nil,
          nextProgramPart: try index.nextProgramPart(forRecording: existing.recordingID),
          previouslyArchived: []
        )
        try recordingSession.resume(take, at: now, settings: settings)
        recordingID = existing.recordingID
      } else {
        recordingID = try recordingSession.open(at: now, settings: settings)
        try catalog.add(recordingID: recordingID, liveStreamId: liveStreamId, gameId: gameId, angleName: angleName)
        try recordingSession.startProgramme(at: now, settings: settings)
      }
    } catch {
      telemetry.recordRecordingError("\(error)")
      if recordingSession.isRecording { recordingSession.close(endedAt: now) }
      fail(.recordingFailed)
      throw PhoneStreamError.recordingFailed
    }
    try? catalog.setLive(.init(liveStreamId: liveStreamId, gameId: gameId, angleName: angleName))
    stream = StreamTake(
      liveStreamId: liveStreamId,
      gameId: gameId,
      angleName: angleName,
      request: request,
      recordingID: recordingID,
      firstURL: rtmpUrl,
      cachedURL: rtmpUrl
    )
    recordingTakeID = recordingID
    liveStartWanted = true
    beginLiveSession(recording: recordingID)
    streamController.start(reason: .start)
    startStorageLoop()
    publishStatus()
  }

  /// Stops the stream and the recording, the recording with its hold fill and sound check.
  public func stopRecording() async {
    guard stream != nil else { return }
    stream = nil
    liveStartWanted = false
    suspendedInBackground = false
    streamController.stop()
    storageLoop?.cancel()
    storageLoop = nil
    try? catalog.clearLive()
    await partFinished()
    if recordingTakeID != nil {
      await finishPart(endedAt: environment.clock.now, closingTake: true)
    }
    recordingSession.endLiveSession(stillLive: false)
    publishStatus()
  }

  public var isRecording: Bool { recordingTakeID != nil }
  /// A part is being finished; recording cannot start again until it has.
  public var isFinishingPart: Bool { finishing != nil }
  public var isStreaming: Bool { stream != nil }

  private func beginLiveSession(recording: Int64?) {
    recordingSession.beginLiveSession(recording: recording, streaming: true) { [weak self] in
      self?.stream != nil
    }
  }

  /// Finishes the part being written: out to `endedAt` plus the picture delay, so its file reaches
  /// the moment of the stop, with the recording's mix flushed so its sound reaches its picture.
  /// `closingTake` writes the take's end; the background leaves it open for the resume.
  private func finishPart(endedAt: WallClock, closingTake: Bool) async {
    recordingTakeID = nil
    recordingSession.detachAnchors()
    let task = Task { @MainActor [self] in
      let tail = environment.stopTailSeconds
      let waited = environment.clock.now - endedAt
      if tail > waited {
        try? await Task.sleep(for: .seconds(tail - waited))
      }
      // The hold fill carries the picture from here; the programme's own pictures stop.
      programme.setFeedsRecording(false)
      programme.recordingMix.flush(through: environment.clock.now)
      _ = await recordingSession.finishProgramme(until: endedAt + tail)
      if closingTake { recordingSession.close(endedAt: endedAt) }
    }
    finishing = task
    await task.value
    if finishing == task { finishing = nil }
  }

  /// Waits for a part that is being finished, if one is.
  private func partFinished() async {
    await finishing?.value
  }

  /// The address for a dial. The first `.start` dial is the URL JS was given; every other asks the
  /// server again with the stream held, so an ended stream stays ended.
  private func streamURL(for reason: StreamSessionController.DialReason) async throws -> String {
    guard var take = stream else { throw CancellationError() }
    if reason == .start, let first = take.firstURL {
      take.firstURL = nil
      stream?.firstURL = nil
      return first
    }
    let client = TeamStationClient(
      baseURL: take.request.serverURL,
      token: take.request.token,
      session: environment.urlSession
    )
    do {
      let held = try await client.requestLiveStream(
        gameId: take.gameId,
        label: take.angleName,
        deviceId: take.request.deviceId,
        deviceModel: take.request.deviceModel,
        heldStreamId: take.liveStreamId
      )
      guard let url = held.url else { throw TeamStationError.server("no stream address") }
      stream?.cachedURL = url
      return url
    } catch TeamStationError.streamEnded {
      throw StreamEndedError()
    } catch {
      // Offline, or the server could not answer: the address held is still the stream's.
      if let cached = take.cachedURL { return cached }
      throw error
    }
  }

  // MARK: - Interruption and resume

  /// The take that was rolling when the app last stopped, if reopening the streaming screen now
  /// would continue it: within the hour, and still open.
  public func interruptedSession() -> PhoneInterruptedSession? {
    guard stream == nil, let live = try? catalog.live(),
      let plan = try? LiveSessionResume.plan(
        index: index,
        now: environment.clock.now,
        limit: PhoneStreamProfile.resumeDowntimeLimitSeconds
      ),
      case let .resume(take, streaming) = plan.outcome
    else { return nil }
    return PhoneInterruptedSession(
      liveStreamId: live.liveStreamId,
      gameId: live.gameId,
      angleName: live.angleName,
      recordingID: take?.recordingID,
      streaming: streaming,
      downtime: plan.downtime
    )
  }

  /// Continues the interrupted take as its next part, timed from its first picture, and redials its
  /// stream with the stream held. False when there is nothing to continue; a take away longer than
  /// the hour is closed where it got to.
  @discardableResult
  public func resumeInterrupted(request: PhoneStreamRequest) throws -> Bool {
    guard isOpen, stream == nil, finishing == nil else { throw PhoneStreamError.notReady }
    guard let live = try catalog.live() else { return false }
    let plan = try LiveSessionResume.plan(
      index: index,
      now: environment.clock.now,
      limit: PhoneStreamProfile.resumeDowntimeLimitSeconds
    )
    guard let plan, case let .resume(take, _) = plan.outcome else {
      closeInterruptedTake()
      return false
    }
    angleName = live.angleName
    lastError = nil
    stream = StreamTake(
      liveStreamId: live.liveStreamId,
      gameId: live.gameId,
      angleName: live.angleName,
      request: request,
      recordingID: take?.recordingID ?? (try? catalog.current(forLiveStream: live.liveStreamId))?.recordingID
    )
    if let take {
      if environment.storageRules.canStart(freeBytes: environment.freeDiskBytes()) {
        do {
          programme.setFeedsRecording(true)
          try recordingSession.resume(take, at: environment.clock.now, settings: PhoneStreamProfile.recordingSettings)
          recordingTakeID = take.recordingID
        } catch {
          telemetry.recordRecordingError("\(error)")
          lastError = .recordingFailed
        }
      } else {
        try? catalog.closeAtLastAnchor(take.recordingID)
        try? catalog.markStoppedForLowStorage(take.recordingID)
        lastError = .recordingStoppedLowStorage
      }
    }
    suspendedInBackground = false
    liveStartWanted = true
    beginLiveSession(recording: recordingTakeID)
    streamController.start(reason: .redial)
    startStorageLoop()
    publishStatus()
    return true
  }

  /// Closes a take a kill left open, at the last moment its programme reached, and forgets the
  /// live session.
  private func closeInterruptedTake() {
    if let open = try? index.liveRecording() {
      try? catalog.closeAtLastAnchor(open.id)
    }
    try? index.closeLiveSession()
    try? catalog.clearLive()
  }

  /// The app went to the background: capture ends, so the part is finished, the heartbeat stops and
  /// the stream drops. The take stays open for the foreground to continue.
  public func enterBackground() async {
    guard stream != nil else { return }
    suspendedInBackground = true
    streamController.stop()
    storageLoop?.cancel()
    storageLoop = nil
    recordingSession.stopHeartbeat()
    if recordingTakeID != nil {
      await finishPart(endedAt: environment.clock.now, closingTake: false)
    }
    publishStatus()
  }

  /// Back in the foreground with the engine still open: the take continues as its next part.
  public func enterForeground() async {
    await partFinished()
    guard suspendedInBackground, isOpen, let take = stream else { return }
    stream = nil
    suspendedInBackground = false
    _ = try? resumeInterrupted(request: take.request)
  }

  private func observeApplication() {
    let center = NotificationCenter.default
    applicationObservers.append(center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in await self?.enterBackground() }
    })
    applicationObservers.append(center.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in await self?.enterForeground() }
    })
  }

  // MARK: - Storage

  private func startStorageLoop() {
    storageLoop?.cancel()
    let interval = environment.storageCheckInterval
    storageLoop = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(interval))
        guard !Task.isCancelled, let self else { return }
        await self.checkStorage()
      }
    }
  }

  /// A part finishes cleanly once free space falls under the floor; the stream goes on, and the take
  /// no longer covers the whole stream.
  func checkStorage() async {
    guard let id = recordingTakeID,
      environment.storageRules.mustStop(freeBytes: environment.freeDiskBytes())
    else { return }
    try? catalog.markStoppedForLowStorage(id)
    try? catalog.markPublishedOutsideParts(id)
    lastError = .recordingStoppedLowStorage
    recordingSession.endLiveSession(recording: true, stillLive: true)
    await finishPart(endedAt: environment.clock.now, closingTake: true)
    publishStatus()
  }

  // MARK: - Status

  private func startStatusLoop() {
    statusLoop?.cancel()
    let interval = environment.statusInterval
    statusLoop = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        self?.publishStatus()
        try? await Task.sleep(for: .seconds(interval))
      }
    }
  }

  /// The status as it is now.
  public var status: PhoneStreamStatus {
    let congestion = streamController.refreshCongestion()
    let battery = deviceStatus.battery()
    var recordingSeconds = 0.0
    if recordingTakeID != nil, let started = recordingSession.startedAt {
      recordingSeconds = max(0, environment.clock.now - started)
    }
    return PhoneStreamStatus(
      phase: streamController.phase.rawValue,
      retryInSeconds: streamController.retryInSeconds,
      bitrateKbps: congestion.rate.bitrate / 1_000,
      displayedZoom: cameraState.displayedZoom,
      lensLabel: Self.lensLabel(cameraState),
      batteryPercent: battery?.percent,
      charging: battery?.isCharging ?? false,
      thermal: deviceStatus.thermal().rawValue,
      recordingSeconds: recordingSeconds,
      isRecording: recordingTakeID != nil,
      error: lastError
    )
  }

  func publishStatus() {
    // The stream on the air while no part is recording: the take no longer covers it all.
    if streamController.phase == .live, recordingTakeID == nil, let id = stream?.recordingID {
      try? catalog.markPublishedOutsideParts(id)
    }
    reportLiveStartIfReady()
    emit(.status(status))
  }

  /// How many times the live start is offered to TeamStation, two seconds apart, before it is left to
  /// the server's own placement.
  static let liveStartAttempts = 3

  /// Tells TeamStation when the first picture of this session's first publish was captured, once it
  /// has gone out: TeamStation places the stream's live video there, so it lines up on the wall clock
  /// with the game's other cameras. Placed by when the publish reached the server instead, this
  /// phone's angle played as far behind as its picture delay and dial put it. The server keeps the
  /// first account a stream gets, so a resumed session's, of a later publish, changes nothing there.
  private func reportLiveStartIfReady() {
    guard liveStartWanted, let take = stream, let started = streamer.liveTimelineStart else { return }
    liveStartWanted = false
    let client = TeamStationClient(
      baseURL: take.request.serverURL,
      token: take.request.token,
      session: environment.urlSession
    )
    let gameId = take.gameId
    let streamId = take.liveStreamId
    let recordingID = take.recordingID
    let clock = environment.clock
    let catalog = self.catalog
    liveStartReport = Task {
      // On the server's clock: this phone's can be a second out (`ServerClock`).
      var offset: Double?
      for attempt in 1 ... Self.liveStartAttempts {
        do {
          let known: Double
          if let offset {
            known = offset
          } else {
            known = try await client.serverClockOffset(now: { clock.now.seconds })
            offset = known
            // Kept with the take, whose upload may come hours later.
            if let recordingID { try? catalog.setServerClockOffset(known, for: recordingID) }
          }
          try await client.reportLiveStart(gameId: gameId, streamId: streamId, startedAt: (started + known).date)
          return
        } catch TeamStationError.streamEnded {
          return
        } catch {
          if attempt < Self.liveStartAttempts { try? await Task.sleep(for: .seconds(2)) }
        }
      }
    }
  }

  static func lensLabel(_ state: CameraSession.State) -> String {
    let lenses = state.availableLenses
      .filter { $0.position == state.position && !$0.isSecondaryNative }
      .sorted { $0.displayedZoom < $1.displayedZoom }
    if let lens = lenses.last(where: { $0.displayedZoom <= state.displayedZoom + 0.01 }) {
      return lens.title
    }
    return ZoomMapping.label(forDisplayed: state.displayedZoom)
  }

  // MARK: - Camera

  public func setZoom(displayed: Double) {
    pinchStartDeviceZoom = nil
    source?.device?.setDisplayedZoom(displayed)
  }

  /// A pinch, multiplicative against the zoom when it began; `ended` closes the gesture.
  public func pinch(scale: Double, ended: Bool = false) {
    let start = pinchStartDeviceZoom ?? cameraState.deviceZoom
    pinchStartDeviceZoom = ended ? nil : start
    source?.device?.setDeviceZoom(cameraState.mapping.pinchedDeviceZoom(from: start, scale: scale))
  }

  public func zoomScale() -> PhoneZoomScale {
    let mapping = cameraState.mapping
    return PhoneZoomScale(
      presets: mapping.presetDisplayedZooms,
      switchOvers: mapping.switchOverDeviceZooms.map { mapping.displayedZoom(forDevice: $0) },
      digitalFrom: mapping.softwareZoomStartDisplayedZoom,
      minimum: mapping.displayedZoom(forDevice: mapping.minimumDeviceZoom),
      maximum: mapping.displayedZoom(forDevice: mapping.maximumDeviceZoom),
      current: cameraState.displayedZoom
    )
  }

  /// The phone's physical lenses, one toggle each as on Cameraman's Lenses card, with Cameraman's
  /// rule for which may be turned off. A native crop (the wide's 2x) is a zoom stop, not a lens: it
  /// goes with its sensor, so it is not offered on its own.
  public func lenses() -> [PhoneLens] {
    let catalog = cameraState.availableLenses
    let selection = LensSelection(disabledIDs: captureSettings.disabledLensIDs).normalized(in: catalog)
    return LensSelection.physical(in: catalog).map { lens in
      PhoneLens(
        lens: lens,
        enabled: selection.isEnabled(lens),
        canDisable: selection.canDisable(lens, in: catalog)
      )
    }
  }

  public func setDisabledLenses(_ ids: Set<String>) {
    let selection = LensSelection(disabledIDs: ids).normalized(in: cameraState.availableLenses)
    guard selection.disabledIDs != captureSettings.disabledLensIDs else { return }
    captureSettings.disabledLensIDs = selection.disabledIDs
    source?.device?.configure(position: cameraState.position, settings: captureSettings)
  }

  public func flip() {
    source?.device?.flip()
  }

  /// Mutes the microphone's contribution: both mixes write silence instead.
  public func setAudioEnabled(_ enabled: Bool) {
    audioEnabled = enabled
    programme.setSoundEnabled(enabled)
  }

  // MARK: - Recordings and uploads

  /// The takes on this phone, each filed under its live stream.
  public func recordings() throws -> [PhoneRecording] {
    try catalog.recordings()
  }

  /// Exports the take of `liveStreamId` and sends it as that stream's replacement. Answers the video
  /// it became. An upload of the same take already running in this process is the one returned.
  public func uploadRecording(liveStreamId: String, apiBase: URL, token: String, title: String) async throws -> String {
    guard let recording = try catalog.recordings().first(where: { $0.liveStreamId == liveStreamId }) else {
      throw PhoneStreamError.noRecording
    }
    if let videoId = recording.videoId, recording.isUploaded { return videoId }
    if let running = uploads[recording.recordingID] { return try await running.value }
    await partFinished()
    if stream?.liveStreamId == liveStreamId { throw PhoneStreamError.stillRecording }
    let server = PhoneStreamRequest(apiBase: apiBase, token: token, deviceId: "").serverURL
    return try await startUpload(recording, server: server, token: token, title: title).value
  }

  /// Restarts every upload that was opened and has not landed, except one already running here.
  /// Answers how many it started.
  @discardableResult
  public func resumePendingUploads(apiBase: URL, token: String) -> Int {
    let server = PhoneStreamRequest(apiBase: apiBase, token: token, deviceId: "").serverURL
    let pending = ((try? catalog.recordings()) ?? []).filter {
      $0.hasPendingUpload && uploads[$0.recordingID] == nil
    }
    for recording in pending {
      _ = startUpload(recording, server: server, token: token, title: recording.uploadTitle ?? recording.angleName)
    }
    return pending.count
  }

  /// The ids of the takes whose upload is running in this process.
  public var runningUploads: Set<Int64> { Set(uploads.keys) }

  /// Stops the upload of `liveStreamId` and abandons it on the server, so the take can be recorded
  /// on or uploaded afresh.
  public func cancelUpload(liveStreamId: String) async {
    guard let recording = try? catalog.recordings().first(where: { $0.liveStreamId == liveStreamId }) else { return }
    let id = recording.recordingID
    uploads[id]?.cancel()
    _ = await uploads[id]?.result
    if let uploadId = recording.uploadId, let server = uploadServers[id] {
      await TeamStationClient(baseURL: server.server, token: server.token, session: environment.urlSession)
        .abandonUpload(uploadId: uploadId)
    }
    uploadServers[id] = nil
    try? catalog.setUpload(id: nil, title: nil, for: id)
  }

  /// Deletes the take of `liveStreamId`, its files and its rows. Not while it records or uploads.
  public func deleteRecording(liveStreamId: String) throws {
    guard let recording = try catalog.recordings().first(where: { $0.liveStreamId == liveStreamId }) else { return }
    if stream?.liveStreamId == liveStreamId { throw PhoneStreamError.stillRecording }
    if uploads[recording.recordingID] != nil { throw PhoneStreamError.uploadInProgress }
    try index.deleteRecording(recording.recordingID, roots: environment.storage.fileRoots)
    try catalog.delete(recording.recordingID)
  }

  /// Every running upload stops where it is and keeps its id, as a killed process's would.
  func interruptUploads() async {
    let running = uploads
    for task in running.values { task.cancel() }
    for task in running.values { _ = await task.result }
  }

  private func startUpload(
    _ recording: PhoneRecording,
    server: URL,
    token: String,
    title: String
  ) -> Task<String, Error> {
    let id = recording.recordingID
    uploadServers[id] = (server, token)
    let task = Task { @MainActor [self] () throws -> String in
      defer { uploads[id] = nil }
      let work = environment.backgroundWork.begin("Upload \(recording.angleName)")
      defer { environment.backgroundWork.end(work) }
      do {
        let videoId = try await upload(recording, server: server, token: token, title: title)
        uploadServers[id] = nil
        return videoId
      } catch {
        emit(.upload(PhoneUploadProgress(
          liveStreamId: recording.liveStreamId,
          state: .failed,
          message: "\(error)"
        )))
        throw error
      }
    }
    uploads[id] = task
    return task
  }

  private func upload(_ recording: PhoneRecording, server: URL, token: String, title: String) async throws -> String {
    let liveStreamId = recording.liveStreamId
    emit(.upload(PhoneUploadProgress(liveStreamId: liveStreamId, state: .exporting)))
    if recording.endedAt == nil { try catalog.closeAtLastAnchor(recording.recordingID) }
    guard let summary = try index.recordings().first(where: { $0.id == recording.recordingID }) else {
      throw PhoneStreamError.noRecording
    }
    let storage = environment.storage
    let export = ExportService(
      index: index,
      archives: storage.fileRoots.archives,
      programDirectory: storage.program,
      fallbackEncoding: { PhoneStreamProfile.takeEncoding }
    )
    // From part 1's first picture, placed where it was captured: the upload says when its first
    // frame happened, and the server lines it up with the game's other angles by nothing else.
    let start = Self.uploadStart(
      anchors: (try? index.programAnchors(recordingID: recording.recordingID)) ?? [],
      startedAt: recording.startedAt
    )
    let files = try await export.exportRecording(
      summary,
      cameras: [],
      includeProgram: true,
      programDirectory: storage.program,
      preparedRoot: storage.prepared,
      reprocess: recording.uploadId == nil,
      window: ExportWindow(start: start, end: export.exportWindow(summary, sourceIDs: []).end)
    )
    guard let file = files.first else { throw PhoneStreamError.noRecording }
    try Task.checkCancellation()

    let catalog = self.catalog
    let recordingID = recording.recordingID
    let client = TeamStationClient(baseURL: server, token: token, session: environment.urlSession)
    // The start goes on the server's clock: this phone's can be a second out (`ServerClock`). The
    // offset measured while the take was recorded is the one that fits it; a take that never had
    // one is read now. Unreachable, the upload's own request fails anyway.
    let clock = environment.clock
    var offset = recording.serverClockOffset
    if offset == nil { offset = try? await client.serverClockOffset(now: { clock.now.seconds }) }
    let service = UploadService(client: client)
    let videoId = try await service.send(
      file: file,
      gameId: recording.gameId,
      title: recording.uploadTitle ?? title,
      kind: "program",
      startedAt: (start + (offset ?? 0)).date,
      uploadId: recording.uploadId,
      liveStreamId: liveStreamId,
      wholeStream: recording.coversWholeStream ? true : nil,
      onOpened: { uploadId in
        try? catalog.setUpload(id: uploadId, title: recording.uploadTitle ?? title, for: recordingID)
      },
      onProgress: { [weak self] progress in
        Task { @MainActor in
          self?.emit(.upload(PhoneUploadProgress(
            liveStreamId: liveStreamId,
            state: progress.step == nil ? .uploading : .processing,
            fraction: progress.fraction,
            bytesSent: progress.bytesSent,
            bytesTotal: progress.bytesTotal,
            step: progress.step
          )))
        }
      }
    )
    try catalog.markUploaded(recordingID, videoId: videoId, at: environment.clock.now)
    try? FileManager.default.removeItem(at: RecordingExport.preparedDirectory(
      recordingID: recordingID,
      in: storage.prepared
    ))
    emit(.upload(PhoneUploadProgress(liveStreamId: liveStreamId, state: .uploaded, fraction: 1, videoId: videoId)))
    return videoId
  }

  /// Where an upload of the take with `anchors` starts on the wall clock: when part 1's first picture
  /// was captured, which is the same origin its sound was placed by (`ProgrammeSoundOrigin`). The
  /// take's own start is when Record was pressed, a picture delay or more from any picture in the
  /// file, so the phones' uploads sat on the wall clock as far apart as their delays. A take with no
  /// anchors for its first part has nothing better than its start.
  static func uploadStart(anchors: [ArchiveIndex.ProgramAnchor], startedAt: WallClock) -> WallClock {
    ArchiveIndex.partStarts(anchors)[1] ?? startedAt
  }

  /// Everything stops where it is, as a killed process would leave it: nothing is finished, no
  /// take is closed, and the live session keeps its last heartbeat.
  func abandonForTesting() async {
    statusLoop?.cancel()
    storageLoop?.cancel()
    recordingSession.stopHeartbeat()
    streamController.stop()
    source?.stop()
    programme.stop()
    await interruptUploads()
    stream = nil
    recordingTakeID = nil
    isOpen = false
  }
}
