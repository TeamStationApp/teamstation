import AVFoundation
import DirectorCore
import DirectorNDI
import DirectorRTSP
import DirectorSources
import DirectorTestHarness
import DirectorUI
import SwiftUI
import TeamStationSentry
import TeamStationObservability

/// Wiring only. Everything else lives in the packages so it stays testable without a
/// simulator UI session.
@main
struct DirectorApp: App {
  @State private var environment: AppEnvironment
  @Environment(\.scenePhase) private var scenePhase

  init() {
    AppLog.start(app: .director)
    SentrySetup.start(appId: "app.teamstation.director")
    Self.configureAudioSession()

    let launch = LaunchConfiguration.resolve()
    // One registry, shared: discovery asks it what each camera is called and the source list edits
    // the same cache, so the two can never disagree about a binding.
    let cameras = CameraRegistry()

    _environment = State(initialValue: AppEnvironment(
      launch: launch,
      cameras: cameras,
      discoveryFactory: { kind in
        guard kind != .ndi else {
          return Self.makeNDIDiscovery(launch: launch, coordinator: cameras.playout)
        }
        return RTSPDiscovery(
          configuration: RTSPDiscovery.Configuration(
            path: launch.rtspPath,
            manualHosts: launch.rtspHosts,
            isScanEnabled: launch.rtspScan,
            transport: RTSPSession.Transport(rawValue: launch.rtspTransport) ?? .tcp
          ),
          resolveIdentity: {
            cameras.resolve(endpoints: $0, advertisements: $1, streamAdvertisements: $2)
          },
          requestRelocation: { cameras.reresolve(sourceID: $0) },
          coordinator: cameras.playout,
          advertisementBrowser: CompositeAdvertisementBrowser([
            AWXServiceBrowser(),
            RTSPServiceBrowser()
          ]),
          // Control and identity come from asking each camera; Bonjour only finds them sooner.
          probeControl: { await RTSPControlProbe().probe($0) }
        )
      }
    ))
  }

  /// NDI discovery, and the sources it hands out.
  ///
  /// The archive's encoding comes from here rather than from inside `DirectorNDI` because it is an
  /// operator setting: the free SDK decodes before we see a frame, so unlike an RTSP camera what is
  /// on disk is ours to choose. It is read each time a camera starts archiving, so a take records
  /// with the raw camera settings in force when it began. A launch argument wins for the session,
  /// as it does for the programme master.
  private static func makeNDIDiscovery(
    launch: LaunchConfiguration,
    coordinator: PlayoutCoordinator
  ) -> SourceDiscovery {
    let codecOverride = launch.sourceEncodeCodec
    let bitrateOverride = launch.sourceEncodeBitrate
    let archiveEncoding: @Sendable () -> EncodeSettings = {
      var encoding = ConfigStore().load().rawCameraEncoding
      if let codecOverride { encoding.codec = codecOverride }
      if let bitrateOverride { encoding.bitrate = bitrateOverride }
      return encoding
    }
    if let limit = launch.sourceEncodeLimit {
      NDIArchiveBudget.shared.setCapacity(limit)
    }
    NDIRuntime.shared.setReliableUDP(launch.ndiReliableUDP)

    return NDIDiscovery(
      configuration: NDIDiscovery.Configuration(
        showLocalSources: launch.ndiLocalSources,
        extraIPs: launch.ndiExtraIPs,
        allowedNames: launch.ndiSources
      ),
      makeSource: { discovered, source in
        NDIFrameSource(
          sourceID: discovered.id,
          displayName: discovered.advertisedName,
          ndiName: source.name.full,
          ndiURL: source.url,
          archiveEncoding: archiveEncoding,
          lowBandwidth: launch.ndiBandwidth == "lowest",
          coordinator: coordinator
        )
      }
    )
  }

  var body: some Scene {
    WindowGroup {
      DirectorRootView(environment: environment)
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .inactive:
        // Leave the deck alone while directing. Start the overlay only once the scene is
        // resigning (Control Center, app switch, Settings) during a keep-alive session.
        environment.handleInactive()
      case .background:
        Task { await environment.handleBackground() }
      case .active:
        environment.handleForeground()
      default:
        break
      }
    }
  }

  /// Playback category so the programme mix can use the iPad's current audio route.
  ///
  /// The `audio` background mode in Info.plist only keeps the process running while that mix is
  /// actually playing. Recording and streaming start the player and leave it running after the
  /// scene backgrounds; a preview-only session still lets iOS suspend. See `handleBackground`.
  private static func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .moviePlayback, options: [])
    try? session.setActive(true)
  }
}
