import CameramanControlUI
import CameramanCore
import DirectorPipeline
import SwiftUI

/// Director's own zoom for a camera it cannot drive: an NDI source, a plain RTSP camera, a phone
/// that is not running Cameraman. Director crops the picture itself, so the whole range is the
/// software zoom Cameraman draws in yellow, 1x to `SourceSelectionRules.maximumDigitalZoom`.
///
/// Same controls as the phone's own screen: the rail on the right, pinch on the picture, and a
/// vertical drag anywhere.
struct DigitalZoomCover: View {
  @Environment(AppEnvironment.self) private var environment
  let sourceIndex: Int

  @State private var zoomAtGestureStart: Double?
  @State private var scrubAtGestureStart: Double?
  @State private var pointsPerSegment: CGFloat = 120

  private var mapping: ZoomMapping { DigitalZoomRules.mapping }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let pipeline = environment.router.pipeline(at: sourceIndex) {
        let zoom = environment.digitalZoom(for: pipeline.sourceID)
        CameraPreviewView(renderer: pipeline.renderer)
          .aspectRatio(16 / 9, contentMode: .fit)
          .ignoresSafeArea()
          .gesture(pinch(pipeline, zoom: zoom))
          .accessibilityIdentifier("digital-zoom-screen")

        VStack {
          HStack(spacing: 10) {
            Text(environment.selections.first(where: { $0.id == pipeline.sourceID })?.displayName ?? "")
              .font(.headline)
              .foregroundStyle(.white)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .background(.black.opacity(0.45), in: .rect(cornerRadius: 10))
            Spacer()
          }
          Spacer()
        }
        .padding(24)

        HStack(alignment: .top) {
          Spacer()
          VStack(alignment: .trailing, spacing: 8) {
            closeButton
            ZoomScaleView(
              mapping: mapping,
              displayedZoom: zoom,
              onSelect: { environment.setDigitalZoom($0, for: pipeline.sourceID) },
              onSegmentLength: { length in
                if abs(pointsPerSegment - length) > 0.5 { pointsPerSegment = length }
              }
            )
            .frame(maxHeight: .infinity)
          }
          .padding(.vertical, 24)
          .padding(.trailing, 16)
          .frame(maxHeight: .infinity)
        }
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .simultaneousGesture(scrub(pipeline, zoom: zoom))
      } else {
        closeButton
      }
    }
    .preferredColorScheme(.dark)
  }

  private var closeButton: some View {
    Button {
      environment.closeDigitalZoom()
    } label: {
      Image(systemName: "xmark")
        .font(.system(size: 16, weight: .bold))
        .foregroundStyle(.white)
        .frame(width: 40, height: 40)
        .background(.black.opacity(0.45), in: .circle)
    }
    .accessibilityIdentifier("digital-zoom-close")
    .accessibilityLabel("Close")
  }

  private func pinch(_ pipeline: SourcePipeline, zoom: Double) -> some Gesture {
    MagnifyGesture()
      .onChanged { value in
        let start = zoomAtGestureStart ?? zoom
        zoomAtGestureStart = start
        environment.setDigitalZoom(
          mapping.pinchedDeviceZoom(from: start, scale: value.magnification),
          for: pipeline.sourceID
        )
      }
      .onEnded { _ in zoomAtGestureStart = nil }
  }

  /// Up zooms in; one pill-to-pill gap of travel walks the whole range.
  private func scrub(_ pipeline: SourcePipeline, zoom: Double) -> some Gesture {
    DragGesture(minimumDistance: 12)
      .onChanged { value in
        let start = scrubAtGestureStart ?? zoom
        scrubAtGestureStart = start
        environment.setDigitalZoom(
          mapping.displayedZoom(
            draggingFrom: start,
            byPoints: Double(-value.translation.height),
            pointsPerSegment: Double(pointsPerSegment)
          ),
          for: pipeline.sourceID
        )
      }
      .onEnded { _ in scrubAtGestureStart = nil }
  }
}

/// The scale Director draws for its own zoom.
enum DigitalZoomRules {
  /// A camera with one fixed zoom, extended by Director's software range: 1x to 2x, all yellow.
  static let mapping = ZoomMapping(maximumDeviceZoom: 1).extendedBySoftwareZoom()
}
