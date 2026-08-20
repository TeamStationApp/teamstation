import AVFoundation
import ProducerRTSP
import ProducerSources
import ProducerTestHarness
import ProducerUI
import SwiftUI

/// Wiring only. Everything else lives in the packages so it stays testable without a
/// simulator UI session.
@main
struct ProducerApp: App {
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
      discoveryFactory: {
        RTSPDiscovery(
          configuration: RTSPDiscovery.Configuration(
            path: launch.rtspPath,
            manualHosts: launch.rtspHosts,
            isScanEnabled: launch.rtspScan,
            transport: RTSPSession.Transport(rawValue: launch.rtspTransport) ?? .tcp
          ),
          resolveIdentity: { cameras.resolve(endpoints: $0, advertisements: $1) },
          requestRelocation: { cameras.reresolve(sourceID: $0) },
          coordinator: cameras.playout,
          advertisementBrowser: AWXServiceBrowser()
        )
      }
    ))
  }

  var body: some Scene {
    WindowGroup {
      ProducerRootView(environment: environment)
    }
    .onChange(of: scenePhase) { _, phase in
      // Finalise the recording before iOS suspends us. A suspended app keeps its encode sessions
      // open but cannot feed them, and if it is then killed the writers never finish — the files
      // are truncated and the encode sessions are left for the media daemon to reclaim.
      guard phase == .background else { return }
      Task { await environment.prepareForSuspension() }
    }
  }

  /// Playback category with mixing so the app never interrupts anything else on the iPad.
  ///
  /// R3: the `audio` background mode in Info.plist does **not** keep the pipeline running when the
  /// app is backgrounded. iOS grants that only while audio is actually flowing, and this app plays
  /// none — the session exists so recording does not duck other audio. Backgrounding therefore
  /// finalises the recording rather than continuing it; see `prepareForSuspension`.
  private static func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .default, options: [ .mixWithOthers ])
    try? session.setActive(true)
  }
}
