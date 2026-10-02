import AVFoundation
import UIKit

/// The picture the encoder is given, and nothing else.
///
/// Letterboxed rather than cropped, like the phone's own preview: a capture device on the other end
/// of the HDMI cable needs the encoder's exact framing, bars and all, or what Director receives from
/// it differs from what RTSP would carry.
public final class CleanFeedLayerView: UIView {
  override public class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }

  public var displayLayer: AVSampleBufferDisplayLayer {
    // swiftlint:disable:next force_cast
    layer as! AVSampleBufferDisplayLayer
  }

  override public init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    clipsToBounds = true
    displayLayer.videoGravity = .resizeAspect
    displayLayer.backgroundColor = UIColor.black.cgColor
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is unavailable")
  }
}
