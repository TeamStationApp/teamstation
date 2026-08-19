import AVFoundation
import CameramanCapture
import CameramanCore
import CameramanTestHarness
import Observation
import SwiftUI

/// Wiring for the whole app, injected by the app target so the UI package owns no globals.
@MainActor
@Observable
public final class AppEnvironment {
  public let launch: LaunchConfiguration
  public let camera = CameraSession()

  public private(set) var identity: DeviceIdentity
  public var settings: StreamSettings
  public private(set) var cameraState = CameraSession.State()
  public private(set) var capability: CameraCapabilityReport?
  public private(set) var cameraAuthorized = false
  public private(set) var microphoneAuthorized = false
  public private(set) var status = "starting"

  private let identityProvider: DeviceIdentityProvider

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
    camera.configure(position: .back, settings: settings)
    camera.start()
    status = "running"
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
