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
  public private(set) var identity: DeviceIdentity
  public var settings: StreamSettings
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

  /// Phase 1 startup: permissions, then the capability measurement, which is written to stdout so
  /// `devicectl device process launch --console` can capture it off the device.
  public func start() async {
    status = "requesting permissions"
    cameraAuthorized = await AVCaptureDevice.requestAccess(for: .video)
    microphoneAuthorized = await AVCaptureDevice.requestAccess(for: .audio)

    status = "measuring capabilities"
    let report = await CameraCapabilityProbe().run()
    capability = report

    print("CAMERAMAN_CAPABILITIES_BEGIN")
    print(report.jsonString())
    print("CAMERAMAN_CAPABILITIES_END")

    status = "ready"
  }

  /// Zoom mapping for the widest virtual back camera the measurement found, which is what the
  /// preset pills and the pinch gesture are derived from.
  public var backZoomMapping: ZoomMapping? {
    guard let device = capability?.devices.first(where: { $0.position == "back" }) else { return nil }
    // The ceiling comes from the format's recommended range, not the device's available maximum,
    // which is a 189x digital-upscaling limit on this hardware.
    let recommended = device.formats.compactMap(\.recommendedMaxZoom).min()
    return ZoomMapping(
      minimumDeviceZoom: device.minAvailableZoom,
      maximumDeviceZoom: ZoomMapping.resolveMaximumDeviceZoom(
        recommended: recommended,
        available: device.maxAvailableZoom
      ),
      displayMultiplier: device.displayZoomMultiplier,
      switchOverDeviceZooms: device.switchOverZoomFactors
    )
  }

  public var backFormatCatalogue: FormatCatalogue? {
    guard let device = capability?.devices.first(where: { $0.position == "back" }) else { return nil }
    return FormatCatalogue(formats: device.formats.map {
      CaptureFormatDescriptor(
        width: $0.width,
        height: $0.height,
        minimumFrameRate: $0.minFrameRate,
        maximumFrameRate: $0.maxFrameRate,
        supportsMultiLensSwitching: $0.keepsMultiLensSwitching,
        isBinned: $0.isBinned
      )
    })
  }
}
