import AVFoundation
import AVKit
import CoreMedia
import DirectorPipeline
import UIKit

/// System Picture-in-Picture of the programme output, used as a draggable overlay over other apps.
///
/// Programme frames are enqueued onto a sample-buffer layer that stays in the window so PiP has
/// video to play. That layer is parked off-screen: an in-app monitor would occlude the grid, and
/// iOS replaces a visible source with "This video is playing in Picture in Picture". PiP itself
/// is started only after the scene backgrounds.
public final class ProgramPictureInPicture: NSObject, AVPictureInPictureSampleBufferPlaybackDelegate,
  AVPictureInPictureControllerDelegate, @unchecked Sendable {
  public var isPrepared = false
  public var isActive = false
  public var onStateChange: (@MainActor () -> Void)?

  private var hostView: TileVideoView.SampleBufferView?
  private weak var renderer: TileRenderer?
  private var controller: AVPictureInPictureController?
  private var possibleObservation: NSKeyValueObservation?
  private var wantsPictureInPicture = false
  private weak var host: UIView?

  public override init() {
    super.init()
  }

  @MainActor
  public func attach(renderer: TileRenderer, host: UIView) {
    let view = ensuredHostView()
    let container = host.window ?? host
    if view.superview !== container {
      view.removeFromSuperview()
      container.addSubview(view)
    }
    view.frame = CGRect(x: -640, y: 0, width: 320, height: 180)
    view.autoresizingMask = []
    view.alpha = 1
    view.isHidden = false
    if self.renderer !== renderer {
      self.renderer?.detachPictureInPicture(view.displayLayer)
      renderer.attachPictureInPicture(view.displayLayer)
      self.renderer = renderer
    }
    self.host = host
    prepare()
  }

  @MainActor
  public func prepare() {
    guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
    let layer = ensuredHostView().displayLayer
    if controller == nil {
      let source = AVPictureInPictureController.ContentSource(
        sampleBufferDisplayLayer: layer,
        playbackDelegate: self
      )
      let pip = AVPictureInPictureController(contentSource: source)
      pip.delegate = self
      pip.canStartPictureInPictureAutomaticallyFromInline = false
      pip.requiresLinearPlayback = true
      possibleObservation = pip.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in
          self?.startIfWanted()
        }
      }
      controller = pip
    }
    isPrepared = true
  }

  @MainActor
  public func startIfPossible() {
    wantsPictureInPicture = true
    prepare()
    startIfWanted()
  }

  @MainActor
  private func startIfWanted() {
    guard wantsPictureInPicture, let pip = controller, !pip.isPictureInPictureActive else { return }
    pip.startPictureInPicture()
  }

  public func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    failedToStartPictureInPictureWithError error: Error
  ) {
    // Keep trying on the next possible-change / background; do not tear the source down.
  }

  @MainActor
  public func stopOverlay() {
    wantsPictureInPicture = false
    if let controller, controller.isPictureInPictureActive {
      controller.stopPictureInPicture()
    }
  }

  @MainActor
  public func tearDown() {
    wantsPictureInPicture = false
    possibleObservation = nil
    if let controller, controller.isPictureInPictureActive {
      controller.stopPictureInPicture()
    }
    controller = nil
    isPrepared = false
    isActive = false
  }

  public func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    setPlaying playing: Bool
  ) {
    // Live programme: the overlay is a monitor, not a tape. Pause must not freeze ingest.
  }

  public func pictureInPictureControllerTimeRangeForPlayback(
    _ pictureInPictureController: AVPictureInPictureController
  ) -> CMTimeRange {
    CMTimeRange(start: .zero, duration: .positiveInfinity)
  }

  public func pictureInPictureControllerIsPlaybackPaused(
    _ pictureInPictureController: AVPictureInPictureController
  ) -> Bool {
    false
  }

  public func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    didTransitionToRenderSize newRenderSize: CMVideoDimensions
  ) {}

  public func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    skipByInterval skipInterval: CMTime,
    completion completionHandler: @escaping () -> Void
  ) {
    completionHandler()
  }

  public func pictureInPictureControllerDidStartPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    isActive = true
    notifyStateChange()
  }

  public func pictureInPictureControllerDidStopPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    isActive = false
    notifyStateChange()
  }

  private func notifyStateChange() {
    let handler = onStateChange
    Task { @MainActor in
      handler?()
    }
  }

  @MainActor
  private func ensuredHostView() -> TileVideoView.SampleBufferView {
    if let hostView { return hostView }
    let view = TileVideoView.SampleBufferView(frame: .zero)
    view.isUserInteractionEnabled = false
    view.isAccessibilityElement = false
    view.backgroundColor = .black
    view.displayLayer.videoGravity = .resizeAspect
    view.displayLayer.preventsDisplaySleepDuringVideoPlayback = true
    hostView = view
    return view
  }
}
