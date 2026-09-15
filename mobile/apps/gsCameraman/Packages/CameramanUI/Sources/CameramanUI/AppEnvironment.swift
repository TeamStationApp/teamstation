import AdaptiveBitrate
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
  /// The external display, fed from the same frames the encoder gets.
  public let cleanFeed = CleanFeedController()

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
  /// The phone's battery, for the overlay pill and the wire. Nil on a simulator, which reports
  /// no level.
  public private(set) var battery: BatteryStatus?
  @ObservationIgnored
  private var batteryObservers: [any NSObjectProtocol] = []
  public private(set) var capability: CameraCapabilityReport?
  public private(set) var cameraAuthorized = false
  public private(set) var microphoneAuthorized = false
  public private(set) var status = "starting"
  /// Whether the scene actually reached the background since it was last active. See
  /// `handleBackground`.
  @ObservationIgnored
  private var wasBackgrounded = false
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

  /// What the capture queue needs to decide whether to encode a frame, kept off the main actor so
  /// the decision costs a lock and not a hop. `playingClients` is written from the server's status
  /// callback on its queue.
  @ObservationIgnored
  nonisolated private let encoderGate = OSAllocatedUnfairLock(initialState: EncoderGate())

  private struct EncoderGate: Sendable {
    var playingClients = 0
    var encodeWhenIdle = false
  }

  /// True while frames are being captured but not compressed because nobody is playing.
  public var encoderIdle: Bool {
    let gate = encoderGate.withLock { $0 }
    return !EncoderIdlePolicy.shouldEncodeVideo(
      playingClients: gate.playingClients,
      encodeWhenIdle: gate.encodeWhenIdle,
      hasParameterSets: !latestParameterSets.withLock { $0.isEmpty }
    )
  }

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
  /// Lowers the encoder's rate while the link to a client backs up. Nil until the server exists,
  /// since the server is where the link is measured.
  private var adaptiveBitrate: AdaptiveBitrateLoop?
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

    // A pinned UUID lets a flow assert an exact CNAME. Otherwise the identity is a file in the app's
    // own storage, carried over once from the Keychain where earlier builds kept it.
    let provider: DeviceIdentityProvider
    if let store {
      provider = DeviceIdentityProvider(store: store)
    } else if let pinned = launch.identityUUID {
      provider = DeviceIdentityProvider(
        store: InMemoryIdentityStore(values: [ DeviceIdentityProvider.uuidKey: pinned ])
      )
    } else {
      provider = DeviceIdentityProvider(store: FileIdentityStore(), legacy: LegacyKeychainIdentityStore())
    }
    self.identityProvider = provider
    var loaded = provider.load()
    if let name = launch.cameraName {
      loaded = provider.save(name: name)
    }
    self.identity = loaded
    self.publishedIdentity = OSAllocatedUnfairLock(initialState: loaded)
    self.publishedSettings = OSAllocatedUnfairLock(initialState: initial)
    self.appliedSettings = initial
    // A recording run has no server and so never a client; it must encode regardless.
    encoderGate.withLock { $0.encodeWhenIdle = launch.encodeWhenIdle || launch.recordSeconds > 0 }
    cleanFeed.setEnabled(initial.cleanHDMIEnabled)
    cleanFeed.setStreamSize(width: initial.width, height: initial.height)
    CleanFeedController.active = cleanFeed
    observeThermalState()
    observeBattery()
  }

  /// Force the overlay pill to `state` for `duration`, then return to the live thermal reading.
  public func previewThermal(_ state: ProcessInfo.ThermalState, duration: Duration) {
    thermalPreviewTask?.cancel()
    thermalPreview = state
    thermalPreviewTask = Task { @MainActor in
      try? await Task.sleep(for: duration)
      guard !Task.isCancelled else { return }
      thermalPreview = nil
    }
  }

  /// What the overlay pill shows: a Settings preview if one is running, otherwise telemetry.
  public var thermalLevel: ThermalBadgeLevel {
    if let thermalPreview {
      return ThermalBadgeLevel(process: thermalPreview)
    }
    return ThermalBadgeLevel(telemetryName: thermalState)
  }

  private func observeBattery() {
    UIDevice.current.isBatteryMonitoringEnabled = true
    readBattery()
    for name in [ UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification ] {
      batteryObservers.append(NotificationCenter.default.addObserver(
        forName: name,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        Task { @MainActor in self?.readBattery() }
      })
    }
  }

  private func readBattery() {
    let device = UIDevice.current
    battery = BatteryStatus(
      level: Double(device.batteryLevel),
      isCharging: device.batteryState == .charging || device.batteryState == .full
    )
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

  /// Called when the scene enters the background, purely to record that it happened.
  ///
  /// `.active` also arrives after a merely inactive scene — a Control Center pull, a notification
  /// banner — where nothing was torn down and rebuilding the encoder would cut a working stream for
  /// no reason. Only a real trip to the background needs the repair below.
  public func handleBackground() {
    wasBackgrounded = true
  }

  /// Called when the scene becomes active, to put back the three things iOS takes away.
  ///
  /// None of them are restored on the way in, and none of them are visible from the handset: the
  /// preview keeps rendering throughout, because capture is independent of all three. The app comes
  /// back looking perfectly healthy while Director cannot find it, or finds it and gets no picture.
  public func handleForeground() {
    server?.ensureListening()
    // Unconditionally, not only when the listener had to be rebuilt. iOS drops the Bonjour record
    // the moment the scene leaves the foreground but leaves the listener itself bound and
    // accepting, so the app can be serving on an open port with no advertisement at all. Director
    // finds an iOS camera by `_rtsp._tcp` alone, so that state is invisible to it.
    server?.refreshAdvertisement()

    guard wasBackgrounded else { return }
    wasBackgrounded = false
    // The VideoToolbox session does not survive the background transition, and nothing reports it:
    // encode calls fail against a session that is gone, audio keeps flowing from its own encoder,
    // and the RTSP server keeps serving that audio to anyone who connects. Measured on an iPhone
    // 15 Pro — a fresh launch sends 360 frames in six seconds, and after one background cycle it
    // sends none while audio is unaffected. A source that answers with sound and no picture is
    // worse for Director than one it cannot find, so this is repaired on the way back in.
    guard !launch.useSyntheticCamera, !Self.hasNoCaptureHardware, cameraAuthorized else { return }
    videoEncoder.invalidate()
    videoEncoder.configure(settings: settings)
    videoEncoder.requestKeyframe()
    adaptiveBitrate?.configure(ceiling: settings.bitrate, enabled: settings.adaptiveBitrate)
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
      || next.adaptiveBitrate != previous.adaptiveBitrate
      || next.audioEnabled != previous.audioEnabled
      || next.audioSampleRate != previous.audioSampleRate
      || next.disabledLensIDs != previous.disabledLensIDs
    persistSettings(next)
    syncCleanFeed(next)
    guard pipelineChanged else { return }
    appliedSettings = next

    // A rate-only change is a live parameter, not a reconfigure. Rebuilding the compression session
    // for it would cut every watching client back to its next keyframe, and reopening the camera
    // would reset the zoom.
    let onlyRateChanged = next.codec == previous.codec
      && next.width == previous.width
      && next.height == previous.height
      && next.frameRate == previous.frameRate
      && next.audioEnabled == previous.audioEnabled
      && next.audioSampleRate == previous.audioSampleRate
      && next.disabledLensIDs == previous.disabledLensIDs
    if onlyRateChanged {
      applyRate(next)
      return
    }

    reconfigureVideoEncoder(next)
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
        self?.persistFramingIfChanged(state)
      }
      startEncoding(fromCamera: true)
      camera.configure(position: settings.cameraPosition, settings: settings)
      camera.start()
      // After `start`, so the device is configured and the requested zoom is clamped to what this
      // lens actually supports rather than silently rejected.
      if settings.displayedZoom != 1 { camera.setDisplayedZoom(settings.displayedZoom) }
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
      requestKeyframe: { [videoEncoder] in videoEncoder.requestKeyframe() },
      parameters: { [weak self] request in
        // Same hop the test control server makes: the connection's queue is not the actor this
        // state lives on, and the reply has to describe the state after the write.
        DispatchQueue.main.sync {
          MainActor.assumeIsolated {
            self?.handleParameters(request)
              ?? RTSPResponder.ParameterResponse(statusCode: 503, reasonPhrase: "Service Unavailable")
          }
        }
      }
    )
    let gate = encoderGate
    server.onStatusChange = { [weak self, videoEncoder] status in
      // On the server's queue, before the hop: the capture queue reads the count on the very next
      // frame, and a client that joined while the encoder was idle has no frame to carry the
      // keyframe its PLAY asked for, so the transition asks again.
      let wakes = gate.withLock { current in
        let previous = current.playingClients
        current.playingClients = status.clientCount
        return EncoderIdlePolicy.needsKeyframe(previousClients: previous, currentClients: status.clientCount)
      }
      if wakes { videoEncoder.requestKeyframe() }
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
      path: settingsLock.withLock { $0.path },
      advertise: launch.advertise
    )
    self.server = server

    let adaptiveBitrate = AdaptiveBitrateLoop(
      ceiling: settings.bitrate,
      sample: { [weak server] completion in
        guard let server else { return completion(nil) }
        server.sampleCongestion(completion)
      },
      apply: { [videoEncoder] bitrate in videoEncoder.setBitrate(bitrate) }
    )
    adaptiveBitrate.configure(ceiling: settings.bitrate, enabled: settings.adaptiveBitrate)
    self.adaptiveBitrate = adaptiveBitrate
  }


  private func startEncoding(fromCamera: Bool) {
    videoEncoder.onFailure = { [weak self] failure in
      Task { @MainActor in self?.encodeFailure = failure.description }
    }
    audioEncoder.onFailure = { [weak self] failure in
      Task { @MainActor in self?.encodeFailure = failure.description }
    }
    reconfigureVideoEncoder(settings)
    if settings.audioEnabled && fromCamera {
      audioEncoder.configure(sampleRate: settings.audioSampleRate, channelCount: 1)
    }

    guard fromCamera else { return }
    camera.onCaptureRotationChange = { [videoEncoder] in
      videoEncoder.requestKeyframe()
    }
    camera.onVideoFrame = { [weak self, videoEncoder, cleanFeed, gate = encoderGate, sets = latestParameterSets] sample in
      let blank = !(self?.publishedSettings.withLock { $0.videoEnabled } ?? true)
      let frame = SampleBufferRef(sample.buffer)
      if Self.shouldEncodeVideo(gate, parameterSets: sets) {
        videoEncoder.encode(frame, blank: blank)
      }
      cleanFeed.enqueue(frame, blank: blank)
      self?.noteCapturedFrame()
    }
    camera.onAudioFrame = { [audioEncoder, settingsLock = publishedSettings, gate = encoderGate] sample in
      guard Self.shouldEncodeAudio(gate) else { return }
      let silent = !settingsLock.withLock { $0.audioEnabled }
      audioEncoder.encode(SampleBufferRef(sample.buffer), silent: silent)
    }
  }

  nonisolated private static func shouldEncodeVideo(
    _ gate: OSAllocatedUnfairLock<EncoderGate>,
    parameterSets: OSAllocatedUnfairLock<[Data]>
  ) -> Bool {
    let current = gate.withLock { $0 }
    return EncoderIdlePolicy.shouldEncodeVideo(
      playingClients: current.playingClients,
      encodeWhenIdle: current.encodeWhenIdle,
      hasParameterSets: !parameterSets.withLock { $0.isEmpty }
    )
  }

  nonisolated private static func shouldEncodeAudio(_ gate: OSAllocatedUnfairLock<EncoderGate>) -> Bool {
    let current = gate.withLock { $0 }
    return EncoderIdlePolicy.shouldEncodeAudio(
      playingClients: current.playingClients,
      encodeWhenIdle: current.encodeWhenIdle
    )
  }

  /// A new compression session starts with a keyframe, whose parameter sets replace the ones the
  /// SDP hands out. Clearing them first is what makes the idle encoder run for that one keyframe:
  /// otherwise a codec change with nobody playing would leave DESCRIBE describing the old codec.
  private func reconfigureVideoEncoder(_ settings: StreamSettings) {
    latestParameterSets.withLock { $0 = [] }
    videoEncoder.configure(settings: settings)
    // The new session starts at the ceiling, so the controller does too.
    adaptiveBitrate?.configure(ceiling: settings.bitrate, enabled: settings.adaptiveBitrate)
  }

  /// A new rate, or adaptation switched on or off, handed to the running encoder without rebuilding
  /// it.
  private func applyRate(_ settings: StreamSettings) {
    if let adaptiveBitrate {
      adaptiveBitrate.configure(ceiling: settings.bitrate, enabled: settings.adaptiveBitrate)
    } else {
      videoEncoder.setBitrate(settings.bitrate)
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
    // The same fan-out as the camera path, so a simulator with a virtual external display draws
    // the pattern on it and dump-state's `framesEnqueued` climbs.
    synthetic.onVideoFrame = { [weak self, videoEncoder, cleanFeed, gate = encoderGate, sets = latestParameterSets] buffer in
      let blank = !(self?.publishedSettings.withLock { $0.videoEnabled } ?? true)
      let frame = SampleBufferRef(buffer)
      if Self.shouldEncodeVideo(gate, parameterSets: sets) {
        videoEncoder.encode(frame, blank: blank)
      }
      cleanFeed.enqueue(frame, blank: blank)
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

  // MARK: - Remote control

  /// The phone's state as `GET_PARAMETER *` reports it.
  public var cameraSnapshot: CameraSnapshot {
    CameraSnapshot(
      name: identity.name,
      cname: identity.cname,
      model: CameraCapabilityProbe.modelIdentifier(),
      thermalName: thermalState,
      status: status,
      battery: battery,
      position: cameraState.position,
      deviceType: cameraState.deviceType,
      mapping: cameraState.mapping,
      deviceZoom: cameraState.deviceZoom,
      settings: settings,
      formats: formatOptions,
      lenses: cameraState.availableLenses,
      streamURL: streamURL,
      clientCount: serverStatus.clientCount,
      currentBitrate: adaptiveBitrate?.status.controller.bitrate
    )
  }

  /// Answers a `GET_PARAMETER` / `SET_PARAMETER` body. A write goes through the same
  /// `CameraControlling` methods the phone's own screen uses, so the rail and Settings on the
  /// phone show it at once, and the reply echoes the values as they will land: settings merged,
  /// zoom clamped to the mapping, position and name replaced.
  public func handleParameters(_ request: RTSPResponder.ParameterRequest) -> RTSPResponder.ParameterResponse {
    let current = cameraSnapshot
    switch request.method {
    case .get:
      switch CameraParameters.respondToGet(body: request.body, snapshot: current) {
      case .success(let set):
        return RTSPResponder.ParameterResponse(body: set.encoded)
      case .failure(let error):
        return RTSPResponder.ParameterResponse(statusCode: error.statusCode, reasonPhrase: error.reasonPhrase, body: error.body)
      }
    case .set:
      switch CameraParameters.parseSet(body: request.body, snapshot: current) {
      case .success(let write):
        if let name = write.name { rename(to: name) }
        if let position = write.position, position != cameraState.position { flip() }
        if let zoom = write.displayedZoom { setDisplayedZoom(zoom) }
        // One `applySettings()` for every encoder field in the request, exactly like Done.
        if write.touchesSettings { apply(CameraParameters.settings(applying: write, to: settings)) }
        let applied = CameraParameters.snapshot(applying: write, to: current)
        return RTSPResponder.ParameterResponse(body: CameraParameters.echo(write, applied: applied).encoded)
      case .failure(let error):
        return RTSPResponder.ParameterResponse(statusCode: error.statusCode, reasonPhrase: error.reasonPhrase, body: error.body)
      }
    }
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

  /// The external display as the app sees it. `framesEnqueued` climbing is the only proof the clean
  /// feed is being drawn: a display can be connected with the feed disabled, and a run reporting
  /// zero here while a display is attached has shown nothing on it.
  public struct ExternalDisplayDump: Encodable, Sendable, Equatable {
    public var connected: Bool
    public var mode: String?
    public var framesEnqueued: Int
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
    /// Nil until the server is up. `controller.bitrate` is what the encoder is running at.
    public var adaptiveBitrate: AdaptiveBitrateLoop.Status?
    public var audioEnabled: Bool
    public var videoEnabled: Bool
    public var cleanHDMIEnabled: Bool
    public var externalDisplay: ExternalDisplayDump
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
    /// True while nobody is playing and frames are captured but not compressed.
    public var encoderIdle: Bool
    public var encodeFailure: String?
    public var droppedFrames: Int
    public var physFootprintMB: Int
    public var residentSizeMB: Int
    public var availableMemoryMB: Int
    public var cpuPercent: Double
    public var thermalState: String
    /// Nil on a simulator, which reports no battery.
    public var batteryPercent: Int?
    public var batteryCharging: Bool
    public var cpuCores: Int
    public var cameraFailure: String?
    public var interrupted: Bool
    public var interruptionReason: String?
    public var audioPendingBytes: Int
    public var server: RTSPServer.Status
    public var addresses: [String]
    /// Injected late-delivery state. `sendDelayHeldTotal` climbing is the only proof the fault
    /// harness is actually holding frames rather than merely being configured — a run reporting
    /// zero here while a delay is set has injected nothing, and must not be read as a pass.
    public var sendDelayMilliseconds: Double
    public var sendDelayJitterMilliseconds: Double
    public var sendDelayBurstMilliseconds: Double
    public var sendDelayHeldNow: Int
    public var sendDelayHeldTotal: UInt64
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
      adaptiveBitrate: adaptiveBitrate?.status,
      audioEnabled: settings.audioEnabled,
      videoEnabled: settings.videoEnabled,
      cleanHDMIEnabled: settings.cleanHDMIEnabled,
      externalDisplay: externalDisplayDump,
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
      encoderIdle: encoderIdle,
      encodeFailure: encodeFailure,
      droppedFrames: sendQueueDroppedFrames,
      physFootprintMB: ProcessLoad.physFootprintMB(),
      residentSizeMB: ProcessLoad.residentSizeMB(),
      availableMemoryMB: ProcessLoad.availableMemoryMB(),
      cpuPercent: (ProcessLoad.cpuPercent() * 10).rounded() / 10,
      thermalState: ProcessLoad.thermalStateName(),
      batteryPercent: battery?.percent,
      batteryCharging: battery?.isCharging ?? false,
      cpuCores: ProcessLoad.coreCount,
      cameraFailure: cameraState.failure,
      interrupted: cameraState.isInterrupted,
      interruptionReason: cameraState.interruptionReason,
      audioPendingBytes: audioEncoder.pendingBytes,
      server: dumpServerStatus,
      addresses: ControlServer.localAddresses(),
      sendDelayMilliseconds: sendDelaySummary.delayMilliseconds,
      sendDelayJitterMilliseconds: sendDelaySummary.jitterMilliseconds,
      sendDelayBurstMilliseconds: sendDelaySummary.burstMilliseconds,
      sendDelayHeldNow: sendDelaySummary.held,
      sendDelayHeldTotal: sendDelaySummary.totalHeld
    )
  }

  private var externalDisplayDump: ExternalDisplayDump {
    let status = cleanFeed.status
    return ExternalDisplayDump(connected: status.connected, mode: status.mode, framesEnqueued: status.framesEnqueued)
  }

  private var sendQueueDroppedFrames: Int {
    server?.sendQueueSummaries().reduce(0) { $0 + $1.droppedFrames } ?? 0
  }

  private var sendDelaySummary: (delayMilliseconds: Double, jitterMilliseconds: Double, burstMilliseconds: Double, held: Int, totalHeld: UInt64) {
    server?.sendDelay.summary ?? (0, 0, 0, 0, 0)
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
      flip()
      return ok()

    case let .setZoom(displayed):
      setDisplayedZoom(displayed)
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
      applyRate(settings)
      return ok()

    case let .setAdaptiveBitrate(on):
      settings.adaptiveBitrate = on
      noteSettingsApplied()
      applyRate(settings)
      return ok()

    case let .setCodec(name):
      guard let codec = StreamCodec(rawValue: name) else { return nil }
      // `setCodec` rather than assigning the field, so this carries the new codec's default rate the
      // way the Settings picker does. Leaving HEVC's rate on an H.264 stream is now a saved mistake.
      settings.setCodec(codec)
      noteSettingsApplied()
      reconfigureVideoEncoder(settings)
      return ok()

    case let .setFormat(width, height, fps):
      guard width > 0, height > 0, fps > 0 else { return nil }
      settings.width = width
      settings.height = height
      settings.frameRate = Double(fps)
      noteSettingsApplied()
      camera.configure(position: cameraState.position, settings: settings)
      reconfigureVideoEncoder(settings)
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

    case let .setVideo(on):
      settings.videoEnabled = on
      noteSettingsApplied()
      videoEncoder.requestKeyframe()
      return ok()

    case let .setCleanHDMI(on):
      settings.cleanHDMIEnabled = on
      noteSettingsApplied()
      return ok()

    case let .setSendDelay(milliseconds, jitter, burst):
      server?.sendDelay.configure(
        delayMilliseconds: milliseconds,
        jitterMilliseconds: jitter,
        burstMilliseconds: burst
      )
      return ok()

    case .reset:
      settings = launch.settings
      noteSettingsApplied()
      reconfigureVideoEncoder(settings)
      camera.configure(position: .back, settings: settings)
      return ok()
    }
  }

  /// Saves the lens and zoom the operator settled on, and only when one of them actually moved.
  ///
  /// `onStateChange` fires for focus, exposure and interruption too, so writing unconditionally
  /// would put a `UserDefaults` write on a camera callback several times a second.
  private func persistFramingIfChanged(_ state: CameraSession.State) {
    guard settings.cameraPosition != state.position || settings.displayedZoom != state.displayedZoom
    else { return }
    settings.cameraPosition = state.position
    settings.displayedZoom = state.displayedZoom
    noteSettingsApplied()
  }

  private func noteSettingsApplied() {
    let next = settings
    appliedSettings = next
    publishedSettings.withLock { $0 = next }
    persistSettings(next)
    syncCleanFeed(next)
  }

  /// Both are no-ops when nothing changed, so this can follow every settings write.
  private func syncCleanFeed(_ settings: StreamSettings) {
    cleanFeed.setEnabled(settings.cleanHDMIEnabled)
    cleanFeed.setStreamSize(width: settings.width, height: settings.height)
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

// MARK: - CameraControlling

/// The phone's own screen drives the phone through the same seam a remote screen uses. Almost all
/// of this is forwarding; `apply` is the Done-button pair that already existed.
///
/// The harness `set-codec` / `set-format` cases deliberately do not go through `apply`: they
/// reconfigure only the encoder so a flow can change them mid-run without the capture device being
/// reopened and the zoom reset, which `applySettings()` does on purpose for the operator's Done.
/// `set-bitrate` needs neither: a rate is a live change to the running encoder.
extension AppEnvironment: CameraControlling {
  public var name: String { identity.name }
  public var cname: String { identity.cname }
  public var position: CameraPosition { cameraState.position }
  public var mapping: ZoomMapping { cameraState.mapping }
  public var displayedZoom: Double { cameraState.displayedZoom }
  public var deviceZoom: Double { cameraState.deviceZoom }
  public var availableLenses: [CameraLens] { cameraState.availableLenses }
  public var clientCount: Int { serverStatus.clientCount }
  /// Off under `-uiTest` so a flow sees a still pill rather than a frame mid-shimmer.
  public var animatesChrome: Bool { !launch.isUITest }
  /// A camera in the hand is always answering.
  public var isResponding: Bool { true }

  public func setDisplayedZoom(_ displayed: Double) {
    camera.setDisplayedZoom(displayed)
  }

  public func setDeviceZoom(_ device: Double) {
    camera.setDeviceZoom(device)
  }

  public func flip() {
    camera.flip()
  }

  public func apply(_ settings: StreamSettings) {
    self.settings = settings
    applySettings()
  }

  public func previewThermal(_ state: ProcessInfo.ThermalState) {
    previewThermal(state, duration: .seconds(10))
  }
}
