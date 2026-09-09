import AVFoundation
import DirectorCore
import DirectorNDI
import DirectorRTSP
import DirectorSources
import DirectorTestHarness
import DirectorUI
import SwiftUI

/// Wiring only. Everything else lives in the packages so it stays testable without a
/// simulator UI session.
@main
struct DirectorApp: App {
  @State private var environment: AppEnvironment
  @Environment(\.scenePhase) private var scenePhase

  init() {
    Self.configureAudioSession()

    let launch = LaunchConfiguration.resolve()
    // One registry, shared: discovery asks it what each camera is called and the source list edits
    // the same cache, so the two can never disagree about a binding.
    let cameras = CameraRegistry()

    _environment = State(initialValue: AppEnvironment(
      launch: launch,
      cameras: cameras,
      discoveryFactory: { kind in
        guard kind != .ndi else { return Self.makeNDIDiscovery(launch: launch) }
        return RTSPDiscovery(
          configuration: RTSPDiscovery.Configuration(
            path: launch.rtspPath,
            manualHosts: launch.rtspHosts,
            isScanEnabled: launch.rtspScan,
            transport: RTSPSession.Transport(rawValue: launch.rtspTransport) ?? .tcp
          ),
          resolveIdentity: { cameras.resolve(endpoints: $0, advertisements: $1) },
          requestRelocation: { cameras.reresolve(sourceID: $0) },
          coordinator: cameras.playout,
          advertisementBrowser: CompositeAdvertisementBrowser([
            AWXServiceBrowser(),
            RTSPServiceBrowser()
          ])
        )
      }
    ))
  }

  /// NDI discovery, and the sources it hands out.
  ///
  /// The archive codec is read here rather than inside `DirectorNDI` because it is an operator
  /// setting: the free SDK decodes before we see a frame, so unlike an RTSP camera the codec on
  /// disk is ours to choose. A launch argument wins for the session, as it does for the programme
  /// master.
  private static func makeNDIDiscovery(launch: LaunchConfiguration) -> SourceDiscovery {
    let stored = ConfigStore().load()
    let codec: CompressedFrame.Codec = (launch.sourceEncodeCodec ?? stored.sourceEncodeCodec) == .h264
      ? .h264
      : .hevc
    let bitrate = launch.sourceEncodeBitrate ?? stored.programBitrate
    if let limit = launch.sourceEncodeLimit {
      NDIArchiveBudget.shared.setCapacity(limit)
    }

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
          encodeCodec: codec,
          encodeBitrate: bitrate,
          lowBandwidth: launch.ndiBandwidth == "lowest"
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
