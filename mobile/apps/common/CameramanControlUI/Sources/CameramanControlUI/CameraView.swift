import CameramanCore
import SwiftUI

/// The operating screen: full-bleed picture, pinch to zoom, chrome in the corners, zoom on the right.
///
/// Generic over the thing it controls and the thing it draws. On the phone the picture is the
/// `AVCaptureVideoPreviewLayer` and the model is the app's own environment; in GS Director and
/// GS Preview the picture is their decoded stream and the model talks to the phone over RTSP. The
/// SwiftUI is the same either way, which is the point: an operator who knows the phone's screen
/// already knows the remote one.
public struct CameraView<Model: CameraControlling, Picture: View>: View {
  private let model: Model
  /// Present only when this screen was pushed over something else. Cameraman's own screen is the
  /// app's root and has nothing to close to, so it passes nil and no button is drawn.
  private let onClose: (() -> Void)?
  private let picture: () -> Picture
  /// The zoom the pinch started from. Pinch is multiplicative against this rather than against the
  /// live value, which is what makes it track the fingers instead of drifting.
  @State private var zoomAtGestureStart: Double?
  /// Displayed zoom when a vertical scrub began. Relative to this, not to the live value, so the
  /// finger does not fight the highlight.
  @State private var scrubAtGestureStart: Double?
  /// Center-to-center gap between adjacent pills, measured from the drawn column.
  @State private var pointsPerSegment: CGFloat = 72
  @State private var isShowingSettings = false

  public init(
    model: Model,
    onClose: (() -> Void)? = nil,
    @ViewBuilder picture: @escaping () -> Picture
  ) {
    self.model = model
    self.onClose = onClose
    self.picture = picture
  }

  public var body: some View {
    ZStack {
      picture()
        .ignoresSafeArea()
        .gesture(pinch)
        // On the picture rather than on the enclosing ZStack: an accessibility identifier on a
        // container makes SwiftUI publish it as one element and hides the controls inside it, so a
        // flow can then see the screen but none of its values.
        .accessibilityIdentifier("camera-screen")

      VStack {
        HStack(alignment: .center, spacing: 10) {
          settingsButton
          nameBadge
          if !model.isResponding {
            notRespondingBadge
          }
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
      .opacity(model.isResponding ? 1 : Metrics.dimmedOpacity)

      // Battery pill in the upper-right corner, thermal pill to its left, and the close control
      // left of both when there is one. The zoom rail fills the height below them so the first
      // and last stops keep the same vertical span when lenses are disabled.
      HStack(alignment: .top) {
        Spacer()
        VStack(alignment: .trailing, spacing: 8) {
          HStack(alignment: .center, spacing: 10) {
            if onClose != nil {
              closeButton
            }
            ThermalBadge(level: model.thermalLevel, animate: model.animatesChrome)
            if let battery = model.battery {
              BatteryBadge(status: battery)
            }
          }
          ZoomScaleView(
            mapping: model.mapping,
            displayedZoom: model.displayedZoom,
            onSelect: { model.setDisplayedZoom($0) },
            onSegmentLength: { length in
              if abs(pointsPerSegment - length) > 0.5 { pointsPerSegment = length }
            }
          )
          .frame(maxHeight: .infinity)
          .opacity(model.isResponding ? 1 : Metrics.dimmedOpacity)
        }
        .padding(.top, 24)
        .padding(.bottom, 24)
        .padding(.trailing, 16)
        .frame(maxHeight: .infinity)
      }
      .frame(maxHeight: .infinity)
    }
    .background(.black)
    .contentShape(Rectangle())
    .simultaneousGesture(verticalScrub)
    .sheet(isPresented: $isShowingSettings) {
      SettingsView(model: model)
    }
  }

  private var pinch: some Gesture {
    MagnifyGesture()
      .onChanged { value in
        let start = zoomAtGestureStart ?? model.deviceZoom
        zoomAtGestureStart = start
        model.setDeviceZoom(model.mapping.pinchedDeviceZoom(from: start, scale: value.magnification))
      }
      .onEnded { _ in zoomAtGestureStart = nil }
  }

  /// Vertical drag anywhere. Up zooms in. A drag as long as one pill-to-pill gap walks one segment.
  private var verticalScrub: some Gesture {
    DragGesture(minimumDistance: 12)
      .onChanged { value in
        let start = scrubAtGestureStart ?? model.displayedZoom
        scrubAtGestureStart = start
        let displayed = model.mapping.displayedZoom(
          draggingFrom: start,
          byPoints: Double(-value.translation.height),
          pointsPerSegment: Double(pointsPerSegment)
        )
        model.setDisplayedZoom(displayed)
      }
      .onEnded { _ in scrubAtGestureStart = nil }
  }

  private var nameBadge: some View {
    Text(model.name)
      .font(.headline)
      .foregroundStyle(.white)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(.black.opacity(0.45), in: .rect(cornerRadius: 10))
      .accessibilityIdentifier("camera-name")
  }

  /// Shown while a remote phone has stopped answering polls. The screen stays up: a Wi-Fi blip or
  /// a backgrounded app comes back on its own, and dismissing would throw away the operator's place.
  private var notRespondingBadge: some View {
    Text("Camera not answering")
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(.white)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(Color(red: 0.95, green: 0.24, blue: 0.28).opacity(0.7), in: .rect(cornerRadius: 10))
      .accessibilityIdentifier("camera-not-responding")
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
      model.flip()
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

  private var closeButton: some View {
    Button {
      onClose?()
    } label: {
      Image(systemName: "xmark")
        .font(.title2)
        .padding(14)
        .background(.black.opacity(0.45), in: .circle)
    }
    .foregroundStyle(.white)
    .accessibilityIdentifier("camera-close")
    .accessibilityLabel("Close camera controls")
  }
}

/// File scope rather than nested: a generic type cannot hold static stored properties.
private enum Metrics {
  static let dimmedOpacity = 0.4
}
