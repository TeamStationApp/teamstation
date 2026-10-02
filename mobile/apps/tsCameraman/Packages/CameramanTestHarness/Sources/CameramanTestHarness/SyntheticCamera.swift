import CoreMedia
import CoreVideo
import Foundation

import CameramanCore

/// A camera for machines that have none.
///
/// The simulator has no capture device, so without this everything downstream of `AVCaptureSession`
/// — the encoder, the packetizers, the server, the client count in the HUD — is only ever testable
/// on the handset. It emits frames on the same clock and in the same pixel format real capture
/// does, so the code under test cannot tell the difference.
///
/// The pattern moves and carries a frame counter, which matters more than it sounds: a still image
/// encodes to almost nothing and would make a bitrate assertion meaningless, and a stalled stream
/// and a stream of identical frames look the same in a decoder.
public final class SyntheticCamera: @unchecked Sendable {
  public struct Configuration: Sendable {
    public var width: Int
    public var height: Int
    public var frameRate: Int

    public init(width: Int = 1920, height: Int = 1080, frameRate: Int = 30) {
      self.width = width
      self.height = height
      self.frameRate = frameRate
    }

    public init(_ settings: StreamSettings) {
      self.init(
        width: settings.width,
        height: settings.height,
        frameRate: Int(settings.frameRate.rounded())
      )
    }
  }

  public var onVideoFrame: (@Sendable (CMSampleBuffer) -> Void)?

  private let configuration: Configuration
  private let queue = DispatchQueue(label: "app.teamstation.cameraman.synthetic-camera")
  private var timer: DispatchSourceTimer?
  private var pool: CVPixelBufferPool?
  private var frameIndex: Int64 = 0

  public init(configuration: Configuration = Configuration()) {
    self.configuration = configuration
  }

  public var isRunning: Bool { timer != nil }

  public func start() {
    guard timer == nil else { return }
    pool = Self.makePool(width: configuration.width, height: configuration.height)

    let interval = 1.0 / Double(max(1, configuration.frameRate))
    let timer = DispatchSource.makeTimerSource(queue: queue)
    // A little leeway, because a synthetic camera insisting on exact wakeups burns battery to
    // simulate hardware that does not deliver on exact wakeups either.
    timer.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(2))
    timer.setEventHandler { [weak self] in self?.emit() }
    timer.resume()
    self.timer = timer
  }

  public func stop() {
    timer?.cancel()
    timer = nil
    pool = nil
    frameIndex = 0
  }

  private func emit() {
    guard let pool, let onVideoFrame else { return }

    var pixelBuffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess,
          let pixelBuffer
    else { return }

    draw(into: pixelBuffer, frame: frameIndex)

    // The same 90 kHz-friendly timeline real capture presents, so nothing downstream has to special
    // case a synthetic source.
    let time = CMTime(value: frameIndex, timescale: CMTimeScale(configuration.frameRate))
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: CMTimeScale(configuration.frameRate)),
      presentationTimeStamp: time,
      decodeTimeStamp: .invalid
    )

    var formatDescription: CMFormatDescription?
    guard CMVideoFormatDescriptionCreateForImageBuffer(
      allocator: nil,
      imageBuffer: pixelBuffer,
      formatDescriptionOut: &formatDescription
    ) == noErr, let formatDescription else { return }

    var sampleBuffer: CMSampleBuffer?
    guard CMSampleBufferCreateReadyWithImageBuffer(
      allocator: nil,
      imageBuffer: pixelBuffer,
      formatDescription: formatDescription,
      sampleTiming: &timing,
      sampleBufferOut: &sampleBuffer
    ) == noErr, let sampleBuffer else { return }

    frameIndex += 1
    onVideoFrame(sampleBuffer)
  }

  /// Moving horizontal bands, a vertical stripe that sweeps across, and a bar whose width counts
  /// frames.
  ///
  /// Written with `memset` per row rather than per pixel. A per-pixel loop over 1080p is three
  /// million bounds-checked writes a frame, which in an unoptimised build takes long enough that the
  /// synthetic camera delivers about two frames a second — slow enough to look like the encoder
  /// failing, which is the one thing a test source must never do.
  private func draw(into pixelBuffer: CVPixelBuffer, frame: Int64) {
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

    let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
    let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
    guard let luma = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return }
    let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)

    let shift = Int(frame % 256)
    for row in 0 ..< height {
      memset(luma + row * stride, Int32((row + shift) % 256), width)
    }

    // A stripe sweeping left to right, so a stalled stream is obvious in two consecutive frames and
    // there is vertical detail for the encoder to spend bits on.
    let stripeWidth = min(width, 64)
    let stripeX = Int(frame * 8) % max(1, width - stripeWidth)
    for row in 0 ..< height {
      memset(luma + row * stride + stripeX, 235, stripeWidth)
    }

    // A counter bar across the top: sixteen frames per pixel, so it stays on screen long enough to
    // read off a single screenshot.
    let barHeight = max(2, height / 24)
    let barWidth = min(width, Int(frame / 16) % max(1, width))
    for row in 0 ..< barHeight {
      memset(luma + row * stride, 16, barWidth)
    }

    guard CVPixelBufferGetPlaneCount(pixelBuffer) > 1,
          let chroma = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1)
    else { return }
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
    let chromaHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)

    // Neutral, so the pattern reads as greyscale. Colour would add nothing a decoder check needs.
    for row in 0 ..< chromaHeight {
      memset(chroma + row * chromaStride, 128, chromaStride)
    }
  }

  private static func makePool(width: Int, height: Int) -> CVPixelBufferPool? {
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey: width,
      kCVPixelBufferHeightKey: height,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
    ]
    var pool: CVPixelBufferPool?
    CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
    return pool
  }
}
