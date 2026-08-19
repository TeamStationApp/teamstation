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
  public private(set) var capability: CameraCapabilityReport?
  public private(set) var cameraAuthorized = false
  public private(set) var microphoneAuthorized = false
  public private(set) var status = "starting"
  public private(set) var encodeFailure: String?
  public private(set) var serverStatus = RTSPServer.Status()
  /// Frames in and frames out. Separately, because "the camera is not delivering" and "the encoder
  /// is not producing" look identical from the outside and have nothing in common as faults.
  public private(set) var capturedFrames = 0
  public private(set) var encodedFrames = 0

  private let identityProvider: DeviceIdentityProvider
  private var recorder: ElementaryStreamRecorder?
  private var audioRecorder: AudioStreamRecorder?
  private var server: RTSPServer?
  private var controlServer: ControlServer?
  private var synthetic: SyntheticCamera?
  /// The parameter sets arrive with the first keyframe, and a client may DESCRIBE before then, so the
  /// latest ones are kept for the SDP rather than read out of the encoder on demand.
  private let latestParameterSets = OSAllocatedUnfairLock(initialState: [Data]())

  public init(launch: LaunchConfiguration = LaunchConfiguration(), store: IdentityStore? = nil) {
    self.launch = launch
    self.settings = launch.settings

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
  }

  public func rename(to name: String) {
    identity = identityProvider.save(name: name)
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
  /// encoder fifty times.
  public func applySettings() {
    videoEncoder.configure(settings: settings)
    if settings.audioEnabled {
      audioEncoder.configure(sampleRate: settings.audioSampleRate, channelCount: 1)
    }
    guard !launch.useSyntheticCamera else { return }
    camera.configure(position: cameraState.position, settings: settings)
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
    let identity = identity
    let settings = settings
    let sets = latestParameterSets

    let server = RTSPServer(
      describe: { [audioEncoder] videoSSRC, audioSSRC in
        SDPBuilder(
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
        settings.audioEnabled && audioEncoder.audioSpecificConfig != nil
      },
      identity: { identity },
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
      server?.send(video: frame, codec: settings.codec)
      Task { @MainActor in self?.encodedFrames += 1 }
    }
    audioEncoder.onFrame = { [weak server] frame in
      server?.send(audio: frame)
    }

    server.start(
      port: UInt16(clamping: settings.port),
      fallbackPort: UInt16(clamping: StreamSettings.fallbackPort),
      path: settings.path,
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
    camera.onVideoFrame = { [weak self, videoEncoder] sample in
      videoEncoder.encode(SampleBufferRef(sample.buffer))
      Task { @MainActor in self?.capturedFrames += 1 }
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
      Task { @MainActor in self?.capturedFrames += 1 }
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
    public var isRunning: Bool
    public var capturedFrames: Int
    public var encodedFrames: Int
    public var encodeFailure: String?
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
      isRunning: cameraState.isRunning,
      capturedFrames: capturedFrames,
      encodedFrames: encodedFrames,
      encodeFailure: encodeFailure,
      server: serverStatus,
      addresses: ControlServer.localAddresses()
    )
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
      videoEncoder.configure(settings: settings)
      return ok()

    case let .setCodec(name):
      guard let codec = StreamCodec(rawValue: name) else { return nil }
      settings.codec = codec
      videoEncoder.configure(settings: settings)
      return ok()

    case let .setFormat(width, height, fps):
      guard width > 0, height > 0, fps > 0 else { return nil }
      settings.width = width
      settings.height = height
      settings.frameRate = Double(fps)
      camera.configure(position: cameraState.position, settings: settings)
      videoEncoder.configure(settings: settings)
      return ok()

    case let .setAudio(on):
      settings.audioEnabled = on
      if on { audioEncoder.configure(sampleRate: settings.audioSampleRate, channelCount: 1) }
      return ok()

    case .reset:
      settings = launch.settings
      videoEncoder.configure(settings: settings)
      camera.configure(position: .back, settings: settings)
      return ok()
    }
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
