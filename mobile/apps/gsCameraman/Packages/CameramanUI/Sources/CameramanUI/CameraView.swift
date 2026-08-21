import CameramanCapture
import CameramanCore
import SwiftUI

/// The operating screen: full-bleed preview, pinch to zoom, chrome in the corners, zoom on the right.
public struct CameraView: View {
  @Bindable private var environment: AppEnvironment
  /// The zoom the pinch started from. Pinch is multiplicative against this rather than against the
  /// live value, which is what makes it track the fingers instead of drifting.
  @State private var zoomAtGestureStart: Double?
  /// Displayed zoom when a vertical scrub began. Relative to this, not to the live value, so the
  /// finger does not fight the highlight.
  @State private var scrubAtGestureStart: Double?
  /// Center-to-center gap between adjacent pills, measured from the drawn column.
  @State private var pointsPerSegment: CGFloat = 72
  @State private var isShowingSettings = false

  public init(environment: AppEnvironment) {
    self.environment = environment
  }

  public var body: some View {
    ZStack {
      CameraPreview(
        session: environment.camera.captureSession,
        position: environment.cameraState.position,
        captureRotation: environment.cameraState.captureRotationAngle
      )
      .ignoresSafeArea()
      .gesture(pinch)
      // On the preview rather than on the enclosing ZStack: an accessibility identifier on a
      // container makes SwiftUI publish it as one element and hides the controls inside it, so a
      // flow can then see the screen but none of its values.
      .accessibilityIdentifier("camera-screen")

      VStack {
        HStack(alignment: .center, spacing: 10) {
          settingsButton
          nameBadge
          Spacer()
        }
        Spacer()
        HStack {
          flipButton
          Spacer()
        }
      }
      .padding(24)
      .allowsHitTesting(true)

      HStack {
        Spacer()
        ZoomScaleView(
          mapping: environment.cameraState.mapping,
          displayedZoom: environment.cameraState.displayedZoom,
          onSelect: { environment.camera.setDisplayedZoom($0) },
          onSegmentLength: { length in
            if abs(pointsPerSegment - length) > 0.5 { pointsPerSegment = length }
          }
        )
        .padding(.vertical, 24)
        .padding(.trailing, 16)
      }
    }
    .background(.black)
    .contentShape(Rectangle())
    .simultaneousGesture(verticalScrub)
    .sheet(isPresented: $isShowingSettings) {
      SettingsView(environment: environment)
    }
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

  /// Vertical drag anywhere. Up zooms in. A drag as long as one pill-to-pill gap walks one segment.
  private var verticalScrub: some Gesture {
    DragGesture(minimumDistance: 12)
      .onChanged { value in
        let start = scrubAtGestureStart ?? environment.cameraState.displayedZoom
        scrubAtGestureStart = start
        let displayed = environment.cameraState.mapping.displayedZoom(
          draggingFrom: start,
          byPoints: Double(-value.translation.height),
          pointsPerSegment: Double(pointsPerSegment)
        )
        environment.camera.setDisplayedZoom(displayed)
      }
      .onEnded { _ in scrubAtGestureStart = nil }
  }

  private var nameBadge: some View {
    Text(environment.identity.name)
      .font(.headline)
      .foregroundStyle(.white)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(.black.opacity(0.45), in: .rect(cornerRadius: 10))
      .accessibilityIdentifier("camera-name")
  }

  private var settingsButton: some View {
    Button {
      isShowingSettings = true
    } label: {
      Image(systemName: "gearshape")
        .font(.title2)
        .padding(14)
        .background(.black.opacity(0.45), in: .circle)
    }
    .foregroundStyle(.white)
    .accessibilityIdentifier("settings-button")
    .accessibilityLabel("Camera settings")
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
}
