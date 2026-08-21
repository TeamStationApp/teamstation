import CameramanCore
import SwiftUI

/// Chooses between the operating screen and a diagnostic one.
///
/// The diagnostic screen is not a nicety: a capability measurement run or a denied permission has to
/// be readable on the device, because both are states where there is no picture to show.
public struct RootView: View {
  @State private var environment: AppEnvironment

  public init(environment: AppEnvironment) {
    self.environment = environment
  }

  public var body: some View {
    Group {
      if environment.launch.measureCapabilities || !environment.cameraAuthorized {
        DiagnosticView(environment: environment)
      } else {
        CameraView(environment: environment)
      }
    }
    .task { await environment.start() }
  }
}

/// Every value carries an accessibility identifier so a Maestro flow can assert it without scraping
/// a screenshot.
struct DiagnosticView: View {
  let environment: AppEnvironment

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          Text("GS Cameraman")
            .font(.title.bold())
            .accessibilityIdentifier("app-title")
          Text("status=\(environment.status)")
            .accessibilityIdentifier("status")
          Text("name=\(environment.identity.name)")
            .accessibilityIdentifier("camera-name")
          Text("cname=\(environment.identity.cname)")
            .accessibilityIdentifier("camera-cname")
          Text("camera=\(environment.cameraAuthorized ? "granted" : "denied")")
            .accessibilityIdentifier("camera-permission")
          Text("mic=\(environment.microphoneAuthorized ? "granted" : "denied")")
            .accessibilityIdentifier("mic-permission")

          if let report = environment.capability {
            Divider().overlay(.white.opacity(0.2))
            Text("model=\(report.modelIdentifier)")
              .accessibilityIdentifier("model")
            Text("devices=\(report.devices.count)")
              .accessibilityIdentifier("device-count")
            ForEach(report.portBindings.sorted(by: { $0.key < $1.key }), id: \.key) { port, outcome in
              Text("port\(port)=\(outcome)")
                .accessibilityIdentifier("port-\(port)")
            }
          }
        }
        .padding(28)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .foregroundStyle(.white)
    .font(.system(.body, design: .monospaced))
  }
}
