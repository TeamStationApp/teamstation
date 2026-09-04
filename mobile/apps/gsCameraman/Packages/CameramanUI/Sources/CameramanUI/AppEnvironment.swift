import AVFoundation
import CameramanCapture
import CameramanCore
import CameramanEncode
import CameramanRTSP
import CameramanTestHarness
import Observation
import os
import SwiftUI

/// Wiring for the whole app, injected by the app target so the UI package owns no globals.
@MainActor
@Observable
public final class AppEnvironment {
  public let launch: LaunchConfiguration
  public let camera = CameraSession()
  public let videoEncoder = VideoEncoder()
  public let audioEncoder = AudioEncoder()

  public private(set) var identity: DeviceIdentity
  public var settings: StreamSettings
  public private(set) var cameraState = CameraSession.State()
  /// Live `ProcessInfo` name (`nominal` / `fair` / `serious` / `critical`). The overlay pill maps
  /// these to Cool / Fair / Warm / Hot the same way GS Director does.
  public private(set) var thermalState = ProcessLoad.thermalStateName()
  /// Settings Test Thermal Visuals. Overlay-only; dump-state `thermalState` stays the real name.
  public private(set) var thermalPreview: ProcessInfo.ThermalState?
  @ObservationIgnored
  private var thermalPreviewTask: Task<Void, Never>?
  @ObservationIgnored
  private var thermalObserver: (any NSObjectProtocol)?
  public private(set) var capability: CameraCapabilityReport?
  public private(set) var cameraAuthorized = false
  public private(set) var microphoneAuthorized = false
  public private(set) var status = "starting"
  public private(set) var encodeFailure: String?
  public private(set) var serverStatus = RTSPServer.Status()
  /// Frames in and frames out. Held off Observation and off the main actor so a 30 fps bump does
  /// not publish. dump-state reads these; the UI does not.
  @ObservationIgnored
  nonisolated private let frameCounts = OSAllocatedUnfairLock(initialState: FrameCounts())

  private struct FrameCounts: Sendable {
    var captured = 0
    var encoded = 0
  }

  public var capturedFrames: Int { frameCounts.withLock { $0.captured } }
  public var encodedFrames: Int { frameCounts.withLock { $0.encoded } }

  /// Capture and encode queues call these. They must not hop to the main actor.
  nonisolated func noteCapturedFrame() {
    frameCounts.withLock { $0.captured += 1 }
  }

  nonisolated func noteEncodedFrame() {
    frameCounts.withLock { $0.encoded += 1 }
  }

  private let identityProvider: DeviceIdentityProvider
  private var recorder: ElementaryStreamRecorder?
  private var audioRecorder: AudioStreamRecorder?
  private var server: RTSPServer?
  private var controlServer: ControlServer?
  private var synthetic: SyntheticCamera?
  /// The parameter sets arrive with the first keyframe, and a client may DESCRIBE before then, so the
  /// latest ones are kept for the SDP rather than read out of the encoder on demand.
  private let latestParameterSets = OSAllocatedUnfairLock(initialState: [Data]())
  /// DESCRIBE and RTCP read these rather than the values captured at `startServer`, so a rename or
  /// a codec change is visible to the next client without tearing the listener down.
  private let publishedIdentity: OSAllocatedUnfairLock<DeviceIdentity>
  private let publishedSettings: OSAllocatedUnfairLock<StreamSettings>
  /// The settings last pushed into the encoder and capture session. Compared on apply so Done after
  /// a no-op visit to Settings does not restart anything.
  private var appliedSettings: StreamSettings
  private let settingsStore: StreamSettingsStore

  public init(
    launch: LaunchConfiguration = LaunchConfiguration(),
    store: IdentityStore? = nil,
    settingsStore: StreamSettingsStore = StreamSettingsStore()
  ) {
    self.launch = launch
    self.settingsStore = settingsStore

    // What the operator last chose comes back, except where this launch named a value outright.
    var initial = launch.settings
    if launch.persistSettings, let saved = settingsStore.load() {
      initial = launch.settings.merging(saved: saved, keeping: launch.providedSettingFields)
    }
    self.settings = initial

    // A pinned UUID lets a flow assert an exact CNAME. Otherwise the Keychain copy is authoritative
    // so the identity survives a delete-and-reinstall.
    let resolvedStore: IdentityStore
    if let store {
      resolvedStore = store
    } else if let pinned = launch.identityUUID {
      resolvedStore = InMemoryIdentityStore(values: [ DeviceIdentityProvider.uuidKey: pinned ])
    } else {
      resolvedStore = KeychainIdentityStore()
    }

    let provider = DeviceIdentityProvider(store: resolvedStore)
    self.identityProvider = provider
    var loaded = provider.load()
    if let name = launch.cameraName {
      loaded = provider.save(name: name)
    }
    self.identity = loaded
    self.publishedIdentity = OSAllocatedUnfairLock(initialState: loaded)
    self.publishedSettings = OSAllocatedUnfairLock(initialState: initial)
    self.appliedSettings = initial
    observeThermalState()
  }

  /// Force the overlay pill to `state` for `duration`, then return to the live thermal reading.
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

  /// What the overlay pill shows: a Settings preview if one is running, otherwise telemetry.
  public var displayedThermalLevel: ThermalBadgeLevel {
    if let thermalPreview {
      return ThermalBadgeLevel(process: thermalPreview)
    }
    return ThermalBadgeLevel(telemetryName: thermalState)
  }

  private func observeThermalState() {
    thermalState = ProcessLoad.thermalStateName()
    thermalObserver = NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        self?.thermalState = ProcessLoad.thermalStateName()
      }
    }
  }

  public func rename(to name: String) {
    let next = identityProvider.save(name: name)
    identity = next
    publishedIdentity.withLock { $0 = next }
    server?.refreshAdvertisement()
  }

  /// The formats this camera actually offers, for the settings picker. Empty until capture has
  /// configured a device, which is the normal state on a simulator.
  public var formatOptions: [FormatCatalogue.Option] {
    FormatCatalogue(formats: cameraState.availableFormats).options
  }

  /// Where a client should point. The bound port rather than the requested one, because the
  /// fallback is exactly the case where the operator needs to be told.
  public var streamURL: String {
    let host = ControlServer.localAddresses().first { $0 != "127.0.0.1" } ?? "0.0.0.0"
    let port = serverStatus.port.map(Int.init) ?? settings.port
    return "rtsp://\(host):\(port)\(settings.path)"
  }

  /// Pushes edited settings into the pieces that care. Called once when the settings sheet closes
  /// rather than on each change, so a drag along the bitrate slider does not reconfigure the
  /// encoder fifty times. A visit that changed nothing is a no-op, so the stream is not cut by
  /// opening Settings to copy the URL.
  public func applySettings() {
    let next = settings
    publishedSettings.withLock { $0 = next }
    let previous = appliedSettings
    let pipelineChanged = next.codec != previous.codec
      || next.width != previous.width
      || next.height != previous.height
      || next.frameRate != previous.frameRate
      || next.bitrate != previous.bitrate
      || next.audioEnabled != previous.audioEnabled
      || next.audioSampleRate != previous.audioSampleRate
      || next.disabledLensIDs != previous.disabledLensIDs
    persistSettings(next)
    guard pipelineChanged else { return }
    appliedSettings = next
    videoEncoder.configure(settings: next)
    if next.audioEnabled {
      audioEncoder.configure(sampleRate: next.audioSampleRate, channelCount: 1)
    }
    guard !launch.useSyntheticCamera else { return }
    camera.configure(position: cameraState.position, settings: next)
  }

  public func start() async {
    status = "requesting permissions"
    cameraAuthorized = await AVCaptureDevice.requestAccess(for: .video)
    microphoneAuthorized = await AVCaptureDevice.requestAccess(for: .audio)

    if launch.measureCapabilities {
      await measureCapabilities()
      return
    }

    // The synthetic source is the only one a simulator has, so it is checked before the permission
    // gate — there is no camera to be denied access to.
    if launch.useSyntheticCamera || Self.hasNoCaptureHardware {
      startEncoding(fromCamera: false)
      startSynthetic()
    } else {
      guard cameraAuthorized else {
        status = "camera permission denied"
        return
      }

      camera.onStateChange = { [weak self] state in
        self?.cameraState = state
      }
      startEncoding(fromCamera: true)
      camera.configure(position: .back, settings: settings)
      camera.start()
    }

    if launch.isUITest { startControlServer() }

    // Recording is a verification mode that writes to a file instead of serving clients, so the
    // server stays down for it and the port is left free.
    if launch.recordSeconds > 0 {
      status = "running"
      await record(seconds: launch.recordSeconds)
      return
    }

    startServer()
    status = "running"

    if launch.selfTest {
      // Give the listener a moment to reach .ready before knocking on it.
      try? await Task.sleep(for: .seconds(2))
      let result = await LoopbackProbe.run(
        port: UInt16(clamping: settings.port),
        path: settings.path
      )
      print("CAMERAMAN_LOOPBACK_BEGIN")
      printJSON(result)
      print("CAMERAMAN_LOOPBACK_END")
    }
  }

  private func startServer() {
    let sets = latestParameterSets
    let identityLock = publishedIdentity
    let settingsLock = publishedSettings

    let server = RTSPServer(
      describe: { [audioEncoder] videoSSRC, audioSSRC in
        let identity = identityLock.withLock { $0 }
        let settings = settingsLock.withLock { $0 }
        return SDPBuilder(
          identity: identity,
          video: SDPBuilder.VideoTrack(
            codec: settings.codec,
            parameterSets: sets.withLock { $0 },
            width: settings.width,
            height: settings.height
          ),
          audio: audioEncoder.audioSpecificConfig.map {
            SDPBuilder.AudioTrack(
              audioSpecificConfig: $0,
              sampleRate: settings.audioSampleRate,
              channelCount: 1
            )
          },
          videoSSRC: videoSSRC,
          audioSSRC: audioSSRC
        ).build()
      },
      hasAudio: { [audioEncoder] in
        settingsLock.withLock { $0.audioEnabled } && audioEncoder.audioSpecificConfig != nil
      },
      identity: { identityLock.withLock { $0 } },
      requestKeyframe: { [videoEncoder] in videoEncoder.requestKeyframe() }
    )
    server.onStatusChange = { [weak self] status in
      Task { @MainActor in
        self?.serverStatus = status
        // Printed as well as shown, because a bind failure on a handset is otherwise invisible from
        // the Mac driving the test.
        self?.printJSON(status)
      }
    }

    videoEncoder.onFrame = { [weak self, weak server] frame in
      if !frame.parameterSets.isEmpty { sets.withLock { $0 = frame.parameterSets } }
      server?.send(video: frame, codec: settingsLock.withLock { $0.codec })
      self?.noteEncodedFrame()
    }
    audioEncoder.onFrame = { [weak server] frame in
      server?.send(audio: frame)
    }

    server.start(
      port: UInt16(clamping: settingsLock.withLock { $0.port }),
      fallbackPort: UInt16(clamping: StreamSettings.fallbackPort),
      path: settingsLock.withLock { $0.path },
      advertise: launch.advertise
    )
    self.server = server
  }


  private func startEncoding(fromCamera: Bool) {
    videoEncoder.onFailure = { [weak self] failure in
      Task { @MainActor in self?.encodeFailure = failure.description }
    }
    audioEncoder.onFailure = { [weak self] failure in
      Task { @MainActor in self?.encodeFailure = failure.description }
    }
    videoEncoder.configure(settings: settings)
    if settings.audioEnabled && fromCamera {
      audioEncoder.configure(sampleRate: settings.audioSampleRate, channelCount: 1)
    }

    guard fromCamera else { return }
    camera.onCaptureRotationChange = { [videoEncoder] in
      videoEncoder.requestKeyframe()
    }
    camera.onVideoFrame = { [weak self, videoEncoder] sample in
      videoEncoder.encode(SampleBufferRef(sample.buffer))
      self?.noteCapturedFrame()
    }
    camera.onAudioFrame = { [audioEncoder] sample in
      audioEncoder.encode(SampleBufferRef(sample.buffer))
    }
  }

  /// Frames from a pattern generator instead of a lens, so the encode-and-serve path is exercisable
  /// on a simulator. There is no synthetic microphone: audio has nothing device-specific in its
  /// path, so a silent stream would prove nothing that the AAC unit tests do not already.
  /// True only on a simulator, which has no capture device at all.
  ///
  /// Decided by the build target rather than by asking `AVCaptureDevice` and finding nothing: on a
  /// handset an empty device list means the camera is broken or the permission was refused, and
  /// quietly serving a test pattern instead of saying so would be the worst possible answer.
  private static var hasNoCaptureHardware: Bool {
    #if targetEnvironment(simulator)
      true
    #else
      false
    #endif
  }

  private func startSynthetic() {
    let synthetic = SyntheticCamera(configuration: SyntheticCamera.Configuration(settings))
    synthetic.onVideoFrame = { [weak self, videoEncoder] buffer in
      videoEncoder.encode(SampleBufferRef(buffer))
      self?.noteCapturedFrame()
    }
    synthetic.start()
    self.synthetic = synthetic

    cameraState.isRunning = true
    cameraState.deviceType = "synthetic"
    // The same badge the real camera fills in, so a flow asserting on the format reads one thing
    // whichever source it ran against.
    cameraState.activeFormat = CaptureFormatDescriptor(
      width: settings.width,
      height: settings.height,
      minimumFrameRate: settings.frameRate,
      maximumFrameRate: settings.frameRate,
      supportsMultiLensSwitching: false,
      isBinned: false
    )
  }

  // MARK: - The control channel

  public struct LensDump: Encodable, Sendable {
    public var id: String
    public var title: String
    public var position: String
    public var displayedZoom: Double
    public var focalLengthMM: Int?
    public var enabled: Bool
  }

  /// What a flow can assert on without reading pixels. Everything here is a decision the app made,
  /// not a rendering of it, so a failing assertion names the decision that was wrong.
  public struct StateDump: Encodable, Sendable {
    public var status: String
    public var cname: String
    public var name: String
    public var codec: String
    public var width: Int
    public var height: Int
    public var frameRate: Double
    public var bitrateMbps: Double
    public var audioEnabled: Bool
    public var position: String
    public var deviceType: String
    public var displayedZoom: Double
    public var deviceZoom: Double
    public var lensIndex: Int
    public var zoomPresets: [Double]
    public var disabledLensIDs: [String]
    public var lenses: [LensDump]
    public var isRunning: Bool
    public var capturedFrames: Int
    public var encodedFrames: Int
    public var encodeFailure: String?
    public var droppedFrames: Int
    public var physFootprintMB: Int
    public var availableMemoryMB: Int
    public var cpuPercent: Double
    public var thermalState: String
    public var cpuCores: Int
    public var cameraFailure: String?
    public var interrupted: Bool
    public var interruptionReason: String?
    public var audioPendingBytes: Int
    public var server: RTSPServer.Status
    public var addresses: [String]
  }

  public var stateDump: StateDump {
    StateDump(
      status: status,
      cname: identity.cname,
      name: identity.name,
      codec: settings.codec.rawValue,
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      bitrateMbps: Double(settings.bitrate) / 1_000_000,
      audioEnabled: settings.audioEnabled,
      position: cameraState.position.rawValue,
      deviceType: cameraState.deviceType,
      displayedZoom: cameraState.displayedZoom,
      deviceZoom: cameraState.deviceZoom,
      lensIndex: cameraState.lensIndex,
      zoomPresets: cameraState.mapping.presetDisplayedZooms,
      disabledLensIDs: settings.disabledLensIDs.sorted(),
      lenses: cameraState.availableLenses.map { lens in
        LensDump(
          id: lens.id,
          title: lens.title,
          position: lens.position.rawValue,
          displayedZoom: lens.displayedZoom,
          focalLengthMM: lens.focalLengthMM,
          enabled: !settings.disabledLensIDs.contains(lens.id)
        )
      },
      isRunning: cameraState.isRunning,
      capturedFrames: capturedFrames,
      encodedFrames: encodedFrames,
      encodeFailure: encodeFailure,
      droppedFrames: sendQueueDroppedFrames,
      physFootprintMB: ProcessLoad.physFootprintMB(),
      availableMemoryMB: ProcessLoad.availableMemoryMB(),
      cpuPercent: (ProcessLoad.cpuPercent() * 10).rounded() / 10,
      thermalState: ProcessLoad.thermalStateName(),
      cpuCores: ProcessLoad.coreCount,
      cameraFailure: cameraState.failure,
      interrupted: cameraState.isInterrupted,
      interruptionReason: cameraState.interruptionReason,
      audioPendingBytes: audioEncoder.pendingBytes,
      server: dumpServerStatus,
      addresses: ControlServer.localAddresses()
    )
  }

  private var sendQueueDroppedFrames: Int {
    server?.sendQueueSummaries().reduce(0) { $0 + $1.droppedFrames } ?? 0
  }

  private var dumpServerStatus: RTSPServer.Status {
    var snapshot = server?.status ?? serverStatus
    let summaries = server?.sendQueueSummaries() ?? []
    snapshot.droppedFrames = summaries.reduce(0) { $0 + $1.droppedFrames }
    snapshot.sendQueuePendingBytes = summaries.reduce(0) { $0 + $1.pendingBytes }
    snapshot.sendQueueFlushes = summaries.reduce(0) { $0 + $1.flushes }
    return snapshot
  }

  private func startControlServer() {
    let server = ControlServer { [weak self] url in
      guard let command = ControlChannel.command(from: url) else { return nil }
      // Hopping to the main actor and waiting: the listener's queue is not the actor this state
      // lives on, and a control channel that returns before the command has run would let a flow
      // assert on the state it was trying to change.
      return DispatchQueue.main.sync {
        MainActor.assumeIsolated { self?.handle(command) }
      }
    }
    do {
      try server.start()
      controlServer = server
    } catch {
      // Not fatal: the app is still usable and the flow will fail on its first command with
      // something more specific than a launch that died.
      print("CAMERAMAN_CONTROL_SERVER_FAILED \(error)")
    }
  }

  private func handle(_ command: ControlCommand) -> Data? {
    switch command {
    case .dumpState:
      return json(stateDump)

    case .clients:
      return json(serverStatus)

    case .flipCamera:
      camera.flip()
      return ok()

    case let .setZoom(displayed):
      camera.setDisplayedZoom(displayed)
      return ok()

    case let .setName(name):
      rename(to: name)
      return ok()

    case .forceKeyframe:
      videoEncoder.requestKeyframe()
      return ok()

    case let .setBitrate(mbps):
      guard mbps > 0 else { return nil }
      settings.bitrate = Int(mbps * 1_000_000)
      noteSettingsApplied()
      videoEncoder.configure(settings: settings)
      return ok()

    case let .setCodec(name):
      guard let codec = StreamCodec(rawValue: name) else { return nil }
      // `setCodec` rather than assigning the field, so this carries the new codec's default rate the
      // way the Settings picker does. Leaving HEVC's rate on an H.264 stream is now a saved mistake.
      settings.setCodec(codec)
      noteSettingsApplied()
      videoEncoder.configure(settings: settings)
      return ok()

    case let .setFormat(width, height, fps):
      guard width > 0, height > 0, fps > 0 else { return nil }
      settings.width = width
      settings.height = height
      settings.frameRate = Double(fps)
      noteSettingsApplied()
      camera.configure(position: cameraState.position, settings: settings)
      videoEncoder.configure(settings: settings)
      return ok()

    case let .setAudio(on):
      settings.audioEnabled = on
      noteSettingsApplied()
      if on { audioEncoder.configure(sampleRate: settings.audioSampleRate, channelCount: 1) }
      return ok()

    case let .setLenses(disabled):
      settings.disabledLensIDs = Set(disabled)
      noteSettingsApplied()
      camera.configure(position: cameraState.position, settings: settings)
      return ok()

    case .reset:
      settings = launch.settings
      noteSettingsApplied()
      videoEncoder.configure(settings: settings)
      camera.configure(position: .back, settings: settings)
      return ok()
    }
  }

  private func noteSettingsApplied() {
    let next = settings
    appliedSettings = next
    publishedSettings.withLock { $0 = next }
    persistSettings(next)
  }

  /// Written on every change rather than on the way out: the app is routinely killed by the operator
  /// or by iOS while backgrounded, and neither gives a chance to save then.
  private func persistSettings(_ settings: StreamSettings) {
    guard launch.persistSettings else { return }
    settingsStore.save(settings)
  }

  private func ok() -> Data { Data(#"{"ok":true}"#.utf8) }

  private func json(_ value: some Encodable) -> Data? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .sortedKeys ]
    return try? encoder.encode(value)
  }

  /// Records the encoder's real output so it can be put through ffprobe. A compression session that
  /// accepts every property and emits an undecodable stream reports no error anywhere, so the only
  /// way to know is to decode the bytes.
  private func record(seconds: Double) async {
    let extension_ = settings.codec == .hevc ? "h265" : "h264"
    let recorder = ElementaryStreamRecorder(filename: "encode-\(settings.codec.rawValue).\(extension_)")
    let audioRecorder = AudioStreamRecorder(filename: "encode-audio.aac")
    self.recorder = recorder
    self.audioRecorder = audioRecorder
    videoEncoder.onFrame = { frame in recorder.append(frame) }
    audioEncoder.onFrame = { frame in audioRecorder.append(frame) }
    status = "recording"

    try? await Task.sleep(for: .seconds(seconds))

    let summary = recorder.finish()
    let audioSummary = audioRecorder.finish()
    videoEncoder.onFrame = nil
    audioEncoder.onFrame = nil
    status = "recorded"

    print("CAMERAMAN_RECORDING_BEGIN")
    printJSON(summary)
    print("CAMERAMAN_RECORDING_END")
    print("CAMERAMAN_AUDIO_RECORDING_BEGIN")
    printJSON(audioSummary)
    print("CAMERAMAN_AUDIO_RECORDING_END")
  }

  private func printJSON<Value: Encodable>(_ value: Value) {
    guard let json = try? JSONEncoder().encode(value),
          let text = String(data: json, encoding: .utf8) else { return }
    print(text)
  }

  /// Takes about 90 seconds — it makes every format on every device active in turn — and it needs its
  /// own capture session, so it runs instead of the live camera rather than alongside it.
  private func measureCapabilities() async {
    status = "measuring capabilities"
    let report = await CameraCapabilityProbe().run()
    capability = report

    print("CAMERAMAN_CAPABILITIES_BEGIN")
    print(report.jsonString())
    print("CAMERAMAN_CAPABILITIES_END")

    status = "measured"
  }
}
