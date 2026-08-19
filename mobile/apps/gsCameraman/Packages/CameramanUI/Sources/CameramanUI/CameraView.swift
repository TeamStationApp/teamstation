import CameramanCapture
import CameramanCore
import SwiftUI

/// The operating screen: full-bleed preview, pinch to zoom, a flip button and preset pills.
public struct CameraView: View {
  @Bindable private var environment: AppEnvironment
  /// The zoom the pinch started from. Pinch is multiplicative against this rather than against the
  /// live value, which is what makes it track the fingers instead of drifting.
  @State private var zoomAtGestureStart: Double?

  public init(environment: AppEnvironment) {
    self.environment = environment
  }

  public var body: some View {
    ZStack {
      CameraPreview(session: environment.camera.captureSession)
        .ignoresSafeArea()
        .gesture(pinch)
        // On the preview rather than on the enclosing ZStack: an accessibility identifier on a
        // container makes SwiftUI publish it as one element and hides the controls inside it, so a
        // flow can then see the screen but none of its values.
        .accessibilityIdentifier("camera-screen")

      VStack {
        HStack(alignment: .top) {
          streamBadge
          Spacer()
          flipButton
        }
        Spacer()
        presetPills
      }
      .padding(24)
    }
    .background(.black)
  }

  private var pinch: some Gesture {
    MagnifyGesture()
      .onChanged { value in
        let start = zoomAtGestureStart ?? environment.cameraState.deviceZoom
        zoomAtGestureStart = start
        environment.camera.setDeviceZoom(
          environment.cameraState.mapping.pinchedDeviceZoom(from: start, scale: value.magnification)
        )
      }
      .onEnded { _ in zoomAtGestureStart = nil }
  }

  private var streamBadge: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(environment.identity.name)
        .font(.headline)
        .accessibilityIdentifier("camera-name")
      Text(ZoomMapping.label(forDisplayed: environment.cameraState.displayedZoom))
        .font(.system(.subheadline, design: .monospaced))
        .accessibilityIdentifier("zoom-label")
      Text("lens \(environment.cameraState.lensIndex)")
        .font(.system(.caption, design: .monospaced))
        .accessibilityIdentifier("lens-index")
      if let format = environment.cameraState.activeFormat {
        Text(format.label)
          .font(.system(.caption, design: .monospaced))
          .accessibilityIdentifier("active-format")
      }
      if let failure = environment.cameraState.failure {
        Text(failure)
          .font(.caption)
          .foregroundStyle(.red)
          .accessibilityIdentifier("camera-failure")
      }
    }
    .foregroundStyle(.white)
    .padding(10)
    .background(.black.opacity(0.45), in: .rect(cornerRadius: 10))
  }

  private var flipButton: some View {
    Button {
      environment.camera.flip()
    } label: {
      Image(systemName: "arrow.triangle.2.circlepath.camera")
        .font(.title2)
        .padding(14)
        .background(.black.opacity(0.45), in: .circle)
    }
    .foregroundStyle(.white)
    .accessibilityIdentifier("flip-button")
    .accessibilityLabel("Flip camera")
  }

  /// Derived from the hardware's switchover factors, so this row is 0.5x / 1x / 3x on a triple
  /// camera and a single 1x on the front camera. A hardcoded set would be wrong on both.
  private var presetPills: some View {
    HStack(spacing: 10) {
      ForEach(environment.cameraState.mapping.presetDisplayedZooms, id: \.self) { preset in
        let isActive = abs(environment.cameraState.displayedZoom - preset) < 0.05
        Button {
          environment.camera.setDisplayedZoom(preset)
        } label: {
          Text(ZoomMapping.label(forDisplayed: preset))
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .frame(minWidth: 46, minHeight: 46)
            .background(isActive ? .white.opacity(0.9) : .black.opacity(0.45), in: .circle)
            .foregroundStyle(isActive ? .black : .white)
        }
        .accessibilityIdentifier("zoom-preset-\(ZoomMapping.label(forDisplayed: preset))")
      }
    }
  }
}
