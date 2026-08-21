import CoreVideo
import Foundation

/// Small wrapper over `CVPixelBufferPool`. Every hot path allocates through a pool rather than
/// `CVPixelBufferCreate` so four 1080p streams do not thrash the allocator.
///
/// The pool is **capped**. Without a threshold, `CVPixelBufferPoolCreatePixelBuffer` grows
/// forever while anything downstream still holds a buffer — which is exactly how preview frames
/// queued in `mediaplaybackd` turned a 20-second recording into an 850 MB process and a jetsam
/// of the whole iPad. Hitting the cap drops the frame (the caller already counts pool misses)
/// instead of taking SpringBoard with it.
public final class PixelBufferFactory: @unchecked Sendable {
  private let pool: CVPixelBufferPool
  private let auxAttributes: CFDictionary
  public let width: Int
  public let height: Int
  public let pixelFormat: OSType
  public let maximumBuffers: Int

  /// Five cameras share one convert pool. Each may hold a preview frame, an in-flight convert,
  /// an archive encode, and a proxy JPEG — 8 was enough to stop the unbounded leak, and too
  /// small to record without dropping.
  public static let defaultMaximumBuffers = 32

  public init?(
    width: Int,
    height: Int,
    pixelFormat: OSType,
    minimumBuffers: Int = 8,
    maximumBuffers: Int = PixelBufferFactory.defaultMaximumBuffers
  ) {
    let cap = max(minimumBuffers, maximumBuffers)
    let poolAttributes: [String: Any] = [
      kCVPixelBufferPoolMinimumBufferCountKey as String: minimumBuffers
    ]
    let bufferAttributes: [String: Any] = [
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      kCVPixelBufferMetalCompatibilityKey as String: true,
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]

    var pool: CVPixelBufferPool?
    let status = CVPixelBufferPoolCreate(
      kCFAllocatorDefault,
      poolAttributes as CFDictionary,
      bufferAttributes as CFDictionary,
      &pool
    )
    guard status == kCVReturnSuccess, let pool else { return nil }

    self.pool = pool
    self.width = width
    self.height = height
    self.pixelFormat = pixelFormat
    self.maximumBuffers = cap
    self.auxAttributes = [
      kCVPixelBufferPoolAllocationThresholdKey as String: cap
    ] as CFDictionary
  }

  public func makeBuffer() -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
      kCFAllocatorDefault,
      pool,
      auxAttributes,
      &buffer
    )
    return status == kCVReturnSuccess ? buffer : nil
  }
}
