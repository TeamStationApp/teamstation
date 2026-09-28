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
  /// The picture's frame in the window, safe area included, so the edge bands are measured from
  /// the glass rather than from wherever the safe area happens to start.
  @State private var pictureFrame: CGRect = .zero
  /// The zoom rail's frame in the window, top pill to bottom pill. A vertical drag zooms only when it
  /// starts inside that band.
  @State private var railFrame: CGRect = .zero
  /// Whether Settings is up. The phone hands in its own, so its test harness can open and close the
  /// sheet; a remote screen leaves it to this view.
  private let settingsShown: Binding<Bool>?
  @State private var ownSettingsShown = false
  private var isShowingSettings: Binding<Bool> { settingsShown ?? $ownSettingsShown }

  public init(
    model: Model,
    onClose: (() -> Void)? = nil,
    isShowingSettings: Binding<Bool>? = nil,
    @ViewBuilder picture: @escaping () -> Picture
  ) {
    self.model = model
    self.onClose = onClose
    self.settingsShown = isShowingSettings
    self.picture = picture
  }

  public var body: some View {
    ZStack {
      picture()
        .ignoresSafeArea()
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { pictureFrame = $0 }
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

      // The zoom rail runs the full height on the right, top pill to bottom pill, so the drag that
      // walks it has as much travel as the screen allows. Battery, thermal and the close control sit
      // to its left along the top, clear of the readout at the rail's middle.
      HStack(alignment: .top, spacing: 10) {
        Spacer()
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
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { railFrame = $0 }
        .opacity(model.isResponding ? 1 : Metrics.dimmedOpacity)
      }
      .padding(.top, 24)
      .padding(.bottom, 24)
      .padding(.trailing, 16)
      .frame(maxHeight: .infinity)
    }
    .background(.black)
    .contentShape(Rectangle())
    .simultaneousGesture(verticalScrub)
    .sheet(isPresented: isShowingSettings) {
      SettingsView(model: model)
    }
  }

  private var pinch: some Gesture {
    MagnifyGesture()
      .onChanged { value in
        // Local to the picture, which ignores the safe area, so already measured from the glass.
        guard !isInSystemEdgeBand(value.startLocation.y) else { return }
        let start = zoomAtGestureStart ?? model.deviceZoom
        zoomAtGestureStart = start
        model.setDeviceZoom(model.mapping.pinchedDeviceZoom(from: start, scale: value.magnification))
      }
      .onEnded { _ in zoomAtGestureStart = nil }
  }

  /// Vertical drag that starts between the top and bottom pills, anywhere across the screen. Up
  /// zooms in. A drag as long as one pill-to-pill gap walks one segment, so the rail's full height
  /// walks the whole range. The rail band stands in for the system edge bands here: it stops short
  /// of both edges, and nothing above or below it starts a zoom.
  ///
  /// Global rather than local: this sits on the ZStack, whose own bounds stop at the safe area.
  private var verticalScrub: some Gesture {
    DragGesture(minimumDistance: 12, coordinateSpace: .global)
      .onChanged { value in
        guard isInRailBand(value.startLocation.y) else { return }
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
      isShowingSettings.wrappedValue = true
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

  /// Whether a gesture that started `y` points below the top of the picture is on its way to the
  /// system instead: Notification Center and Control Center from the top edge, home and the app
  /// switcher from the bottom. Such a gesture leaves the zoom alone for its whole length, however
  /// far it then travels into the picture, so a pull-down does not reframe the shot on the way.
  /// Between the top pill and the bottom pill. Nothing above or below the rail starts a zoom drag.
  private func isInRailBand(_ y: CGFloat) -> Bool {
    guard railFrame.height > 0 else { return true }
    return y >= railFrame.minY && y <= railFrame.maxY
  }

  private func isInSystemEdgeBand(_ y: CGFloat) -> Bool {
    // Before the first layout pass there is no frame to measure against; let the gesture through.
    guard pictureFrame.height > 0 else { return false }
    return y < Metrics.systemEdgeBand || y > pictureFrame.height - Metrics.systemEdgeBand
  }
}

/// File scope rather than nested: a generic type cannot hold static stored properties.
private enum Metrics {
  static let dimmedOpacity = 0.4
  /// About half an inch: an iPhone screen runs roughly 150 to 165 points to the inch. Matches the
  /// 80dp band on Android.
  static let systemEdgeBand: CGFloat = 80
}
