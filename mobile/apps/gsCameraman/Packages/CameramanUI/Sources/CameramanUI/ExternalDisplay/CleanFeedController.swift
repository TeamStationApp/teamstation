import AVFoundation
import CameramanEncode
import CoreMedia
import Foundation
import UIKit

/// Owns the external display: the window on it, the mode it runs in, and the feed drawn into it.
///
/// Off means no window rather than a hidden picture, because a display with no app window on it is
/// what makes iOS fall back to mirroring the phone's screen, which is the documented "off"
/// behaviour. The scene stays connected either way, so flipping the toggle never has to wait for
/// a replug.
@MainActor
public final class CleanFeedController {
  /// The controller a newly connected display is handed to. UIKit instantiates the scene delegate
  /// by class name and cannot be given the environment, so this is where the two meet.
  public static weak var active: CleanFeedController?

  public struct Status: Sendable, Equatable {
    public var connected: Bool
    /// `1920x1080` while a display is connected, from the mode actually in force.
    public var mode: String?
    public var framesEnqueued: Int
  }

  public private(set) var isEnabled = true
  public private(set) var streamSize = CGSize(width: 1920, height: 1080)
  private var scene: UIWindowScene?
  private var window: UIWindow?
  let sink = CleanFeedSink()

  public init() {}

  public var status: Status {
    Status(
      connected: scene != nil,
      mode: scene.flatMap { $0.screen.currentMode }.map { Self.label(for: $0.size) },
      framesEnqueued: sink.framesEnqueued
    )
  }

  public func setEnabled(_ enabled: Bool) {
    guard enabled != isEnabled else { return }
    isEnabled = enabled
    if enabled { showWindow() } else { hideWindow() }
  }

  /// The encoder's dimensions, which decide the display mode: a 1080p stream on a 1080p mode is
  /// carried pixel for pixel by the capture device on the other end of the cable.
  public func setStreamSize(width: Int, height: Int) {
    let size = CGSize(width: width, height: height)
    guard size != streamSize else { return }
    streamSize = size
    applyScreenMode()
  }

  public func displayConnected(_ scene: UIWindowScene) {
    self.scene = scene
    applyScreenMode()
    if isEnabled { showWindow() }
  }

  public func displayDisconnected(_ scene: UIWindowScene) {
    guard scene === self.scene else { return }
    hideWindow()
    self.scene = nil
  }

  /// Called on the capture queue for every frame the encoder is offered, with the same `blank`.
  /// No main-actor hop: the renderer takes frames from any thread.
  nonisolated public func enqueue(_ sample: SampleBufferRef, blank: Bool) {
    sink.enqueue(sample.buffer, blank: blank)
  }

  private func showWindow() {
    guard let scene, window == nil else { return }
    let controller = CleanFeedViewController()
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.isHidden = false
    self.window = window
    sink.attach(controller.layerView.displayLayer)
  }

  /// Detach first so a frame already on the capture queue cannot land on a window being torn down.
  private func hideWindow() {
    sink.detach()
    window?.isHidden = true
    window = nil
  }

  private func applyScreenMode() {
    guard let scene else { return }
    let screen = scene.screen
    let modes = screen.availableModes
    guard let index = Self.modeIndex(matching: streamSize, in: modes.map(\.size)) else { return }
    if screen.currentMode != modes[index] { screen.currentMode = modes[index] }
    // A TV's default overscan would crop the encoder's framing, and the capture device on the
    // other end is not a TV.
    screen.overscanCompensation = .none
  }

  /// The mode whose size is the stream's, else the largest offered. Nil only for a display that
  /// offers nothing, which is left in whatever mode it came up in.
  nonisolated public static func modeIndex(matching stream: CGSize, in sizes: [CGSize]) -> Int? {
    if let exact = sizes.firstIndex(of: stream) { return exact }
    return sizes.indices.max { sizes[$0].width * sizes[$0].height < sizes[$1].width * sizes[$1].height }
  }

  nonisolated static func label(for size: CGSize) -> String {
    "\(Int(size.width))x\(Int(size.height))"
  }
}

/// The capture-queue side of the feed.
///
/// `AVSampleBufferVideoRenderer` accepts frames from any thread, so a frame goes from the capture
/// callback to the display without a main-actor hop that would cost a context switch thirty times
/// a second and a frame of latency. The lock guards the renderer reference against the main actor
/// swapping windows underneath a frame in flight.
final class CleanFeedSink: @unchecked Sendable {
  private let lock = NSLock()
  private var renderer: AVSampleBufferVideoRenderer?
  private var blackFrames = BlackFrameCache()
  private var blackDescription: (buffer: CVPixelBuffer, description: CMVideoFormatDescription)?
  private var enqueued = 0

  var framesEnqueued: Int { lock.withLock { enqueued } }
  var isAttached: Bool { lock.withLock { renderer != nil } }

  func attach(_ layer: AVSampleBufferDisplayLayer) {
    lock.withLock { renderer = layer.sampleBufferRenderer }
  }

  func detach() {
    lock.withLock {
      renderer?.flush()
      renderer = nil
    }
  }

  func enqueue(_ sample: CMSampleBuffer, blank: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard let renderer else { return }
    guard let frame = displayable(sample, blank: blank) else { return }
    // A failed renderer refuses everything until flushed; recovering here rather than on a status
    // observer means the very next frame after a hiccup is shown.
    if renderer.status == .failed || renderer.requiresFlushToResumeDecoding {
      renderer.flush()
    }
    renderer.enqueue(frame)
    enqueued += 1
  }

  /// The frame as the display should see it: the capture picture, or a black one of the same size
  /// and format when video is off, exactly as the encoder substitutes.
  private func displayable(_ sample: CMSampleBuffer, blank: Bool) -> CMSampleBuffer? {
    guard blank, let image = CMSampleBufferGetImageBuffer(sample),
          let black = blackFrames.buffer(matching: image)
    else { return CleanFeedFrame.displayable(sample) }
    if blackDescription?.buffer !== black {
      guard let description = CleanFeedFrame.formatDescription(for: black) else { return nil }
      blackDescription = (black, description)
    }
    return CleanFeedFrame.displayable(sample, image: black, formatDescription: blackDescription?.description)
  }
}
