import AVFoundation
import SwiftUI
import UIKit

public struct PreviewVideoView: UIViewRepresentable {
  private let renderer: PreviewRenderer

  public init(renderer: PreviewRenderer) {
    self.renderer = renderer
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(renderer: renderer)
  }

  public func makeUIView(context: Context) -> SampleBufferView {
    let view = SampleBufferView()
    context.coordinator.renderer = renderer
    renderer.attach(layer: view.displayLayer)
    return view
  }

  public func updateUIView(_ uiView: SampleBufferView, context: Context) {
    if context.coordinator.renderer !== renderer {
      context.coordinator.renderer.detach(layer: uiView.displayLayer)
      context.coordinator.renderer = renderer
    }
    renderer.attach(layer: uiView.displayLayer)
  }

  public func sizeThatFits(
    _ proposal: ProposedViewSize,
    uiView: SampleBufferView,
    context: Context
  ) -> CGSize? {
    let width = proposal.width ?? uiView.bounds.width
    let height = proposal.height ?? uiView.bounds.height
    guard width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
    return CGSize(width: width, height: height)
  }

  public static func dismantleUIView(_ uiView: SampleBufferView, coordinator: Coordinator) {
    coordinator.renderer.detach(layer: uiView.displayLayer)
    uiView.displayLayer.sampleBufferRenderer.flush(removingDisplayedImage: false)
  }

  public final class Coordinator {
    var renderer: PreviewRenderer
    init(renderer: PreviewRenderer) { self.renderer = renderer }
  }

  public final class SampleBufferView: UIView {
    override public class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }

    var displayLayer: AVSampleBufferDisplayLayer {
      layer as! AVSampleBufferDisplayLayer
    }

    override init(frame: CGRect) {
      super.init(frame: frame)
      backgroundColor = .black
      clipsToBounds = true
      displayLayer.videoGravity = .resizeAspect
      setContentHuggingPriority(.defaultLow, for: .horizontal)
      setContentHuggingPriority(.defaultLow, for: .vertical)
      setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    }

    override public func sizeThatFits(_ size: CGSize) -> CGSize {
      size
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) is unavailable")
    }
  }
}
