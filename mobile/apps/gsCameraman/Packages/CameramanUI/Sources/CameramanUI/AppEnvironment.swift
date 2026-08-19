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

  private let identityProvider: DeviceIdentityProvider
  private var recorder: ElementaryStreamRecorder?
  private var audioRecorder: AudioStreamRecorder?
  private var server: RTSPServer?
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

  public func start() async {
    status = "requesting permissions"
    cameraAuthorized = await AVCaptureDevice.requestAccess(for: .video)
    microphoneAuthorized = await AVCaptureDevice.requestAccess(for: .audio)

    if launch.measureCapabilities {
      await measureCapabilities()
      return
    }

    guard cameraAuthorized else {
      status = "camera permission denied"
      return
    }

    camera.onStateChange = { [weak self] state in
      self?.cameraState = state
    }
    startEncoding()
    camera.configure(position: .back, settings: settings)
    camera.start()

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

    videoEncoder.onFrame = { [weak server] frame in
      if !frame.parameterSets.isEmpty { sets.withLock { $0 = frame.parameterSets } }
      server?.send(video: frame, codec: settings.codec)
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


  private func startEncoding() {
    videoEncoder.onFailure = { [weak self] failure in
      Task { @MainActor in self?.encodeFailure = failure.description }
    }
    audioEncoder.onFailure = { [weak self] failure in
      Task { @MainActor in self?.encodeFailure = failure.description }
    }
    videoEncoder.configure(settings: settings)
    if settings.audioEnabled {
      audioEncoder.configure(sampleRate: settings.audioSampleRate, channelCount: 1)
    }

    camera.onVideoFrame = { [videoEncoder] sample in
      videoEncoder.encode(SampleBufferRef(sample.buffer))
    }
    camera.onAudioFrame = { [audioEncoder] sample in
      audioEncoder.encode(SampleBufferRef(sample.buffer))
    }
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
