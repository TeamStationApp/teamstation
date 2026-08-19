import CameramanCore
import SwiftUI

/// Phase 1 screen: proves the app runs on the handset and shows the measured capability set.
///
/// Replaced by the camera preview in Phase 2. Every value carries an accessibility identifier so a
/// Maestro flow can assert the measurement without scraping a screenshot.
public struct RootView: View {
  @State private var environment: AppEnvironment

  public init(environment: AppEnvironment) {
    self.environment = environment
  }

  public var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          header
          Divider().overlay(.white.opacity(0.2))
          identityBlock
          Divider().overlay(.white.opacity(0.2))
          capabilityBlock
        }
        .padding(28)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .foregroundStyle(.white)
    .font(.system(.body, design: .monospaced))
    .task { await environment.start() }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("GS Cameraman")
        .font(.title.bold())
        .accessibilityIdentifier("app-title")
      Text("status=\(environment.status)")
        .accessibilityIdentifier("status")
    }
  }

  private var identityBlock: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("name=\(environment.identity.name)")
        .accessibilityIdentifier("camera-name")
      Text("cname=\(environment.identity.cname)")
        .accessibilityIdentifier("camera-cname")
      Text("camera=\(environment.cameraAuthorized ? "granted" : "denied")")
        .accessibilityIdentifier("camera-permission")
      Text("mic=\(environment.microphoneAuthorized ? "granted" : "denied")")
        .accessibilityIdentifier("mic-permission")
    }
  }

  @ViewBuilder
  private var capabilityBlock: some View {
    if let report = environment.capability {
      VStack(alignment: .leading, spacing: 4) {
        Text("model=\(report.modelIdentifier)")
          .accessibilityIdentifier("model")
        Text("devices=\(report.devices.count)")
          .accessibilityIdentifier("device-count")
        ForEach(report.portBindings.sorted(by: { $0.key < $1.key }), id: \.key) { port, outcome in
          Text("port\(port)=\(outcome)")
            .accessibilityIdentifier("port-\(port)")
        }
        ForEach(Array(report.devices.enumerated()), id: \.offset) { index, device in
          VStack(alignment: .leading, spacing: 2) {
            Text("[\(index)] \(device.deviceType) \(device.position)")
              .bold()
            Text("  lenses=\(device.constituentDeviceTypes.count) switchovers=\(format(device.switchOverZoomFactors))")
              .accessibilityIdentifier("device-\(index)-switchovers")
            Text("  zoom=\(format(device.minAvailableZoom))…\(format(device.maxAvailableZoom)) multiplier=\(format(device.displayZoomMultiplier))")
              .accessibilityIdentifier("device-\(index)-zoom")
            Text("  formats=\(device.formats.count) multiLens=\(device.formats.filter(\.keepsMultiLensSwitching).count)")
              .accessibilityIdentifier("device-\(index)-formats")
          }
          .padding(.top, 6)
        }
      }
    } else {
      Text("measuring…").accessibilityIdentifier("measuring")
    }
  }

  private func format(_ value: Double) -> String {
    String(format: "%.2f", value)
  }

  private func format(_ values: [Double]) -> String {
    values.isEmpty ? "none" : values.map { format($0) }.joined(separator: ",")
  }
}
