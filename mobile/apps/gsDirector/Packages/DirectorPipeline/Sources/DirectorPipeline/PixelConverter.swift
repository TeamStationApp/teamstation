import CoreVideo
import Foundation
import DirectorCore
import DirectorSources
import VideoToolbox

/// Normalises whatever a source delivers — bi-planar 4:2:0 from a hardware decoder, BGRA from
/// the synthetic and file sources — into the
/// bi-planar 4:2:0 form the encoders and the Metal compositor both want.
///
/// I7: this conversion happens **once per frame** and the result is shared by preview, proxy
/// and archive. Converting per consumer would triple the cost at exactly the moment the media
/// engine is already carrying five encode sessions.
///
/// Every source delivers frames on its own thread, and `VTPixelTransferSession` is documented
/// as not thread safe — calling one from two threads trips VideoToolbox's thread trap and
/// kills the process. Sessions are therefore checked out of a free list for the duration of a
/// transfer, so concurrency costs a session rather than correctness. Scaling mode is a
/// per-session property, which is the other reason a single shared session cannot work: the
/// proxy downscale letterboxes while the archive path trims.
public final class PixelConverter: @unchecked Sendable {
  public struct Statistics: Sendable, Equatable {
    public var convertedFrames: UInt64 = 0
    public var passthroughFrames: UInt64 = 0
    public var failedFrames: UInt64 = 0
    /// Exponential moving average, milliseconds.
    public var averageMilliseconds: Double = 0
  }

  public let outputFormat: OSType

  private let lock = NSLock()
  private var idleSessions: [CFString: [VTPixelTransferSession]] = [:]
  private var pools: [PoolKey: PixelBufferFactory] = [:]
  private var statistics = Statistics()

  private struct PoolKey: Hashable {
    let width: Int
    let height: Int
    let format: OSType
  }

  public init(outputFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
    self.outputFormat = outputFormat
  }

  public var currentStatistics: Statistics {
    lock.lock()
    defer { lock.unlock() }
    return statistics
  }

  public func resetStatistics() {
    lock.lock()
    statistics = Statistics()
    lock.unlock()
  }

  /// Returns a frame in `outputFormat` from the capped pool. Live cameras already deliver that
  /// format, but passing those buffers through lets VideoToolbox grow its output pool while the
  /// display layer, compositor and program encoder still hold the previous pictures — the process
  /// then climbs by about one 1080p frame per second until jetsam.
  public func convert(_ frame: PixelFrame) -> PixelFrame? {
    autoreleasepool {
      convertUnpooled(frame)
    }
  }

  private func convertUnpooled(_ frame: PixelFrame) -> PixelFrame? {
    guard let converted = convert(
      pixelBuffer: frame.pixelBuffer,
      width: frame.width,
      height: frame.height
    ) else { return nil }

    return PixelFrame(
      sourceID: frame.sourceID,
      pixelBuffer: converted,
      presentationTime: frame.presentationTime,
      wallClock: frame.wallClock,
      frameID: frame.frameID,
      markerValue: frame.markerValue
    )
  }

  public func convert(pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> CVPixelBuffer? {
    let started = CFAbsoluteTimeGetCurrent()
    let result = transfer(
      pixelBuffer,
      toWidth: width,
      height: height,
      format: outputFormat,
      scalingMode: kVTScalingMode_Trim
    )
    let elapsed = (CFAbsoluteTimeGetCurrent() - started) * 1000

    lock.lock()
    if result == nil {
      statistics.failedFrames += 1
    } else {
      statistics.convertedFrames += 1
      statistics.averageMilliseconds = statistics.averageMilliseconds == 0
        ? elapsed
        : statistics.averageMilliseconds * 0.95 + elapsed * 0.05
    }
    lock.unlock()

    return result
  }

  /// Scales into an arbitrary size and format. Backs the proxy store's 640x360 downscale.
  public func scale(
    _ pixelBuffer: CVPixelBuffer,
    toWidth width: Int,
    height: Int,
    format: OSType
  ) -> CVPixelBuffer? {
    transfer(
      pixelBuffer,
      toWidth: width,
      height: height,
      format: format,
      scalingMode: kVTScalingMode_Letterbox
    )
  }

  // MARK: - Internals

  private func transfer(
    _ pixelBuffer: CVPixelBuffer,
    toWidth width: Int,
    height: Int,
    format: OSType,
    scalingMode: CFString
  ) -> CVPixelBuffer? {
    guard let session = checkOutSession(scalingMode: scalingMode) else { return nil }
    defer { checkIn(session, scalingMode: scalingMode) }
    guard let destination = pool(width: width, height: height, format: format)?.makeBuffer() else {
      return nil
    }
    let status = VTPixelTransferSessionTransferImage(session, from: pixelBuffer, to: destination)
    return status == noErr ? destination : nil
  }

  private func pool(width: Int, height: Int, format: OSType) -> PixelBufferFactory? {
    let key = PoolKey(width: width, height: height, format: format)
    lock.lock()
    defer { lock.unlock() }
    if let existing = pools[key] { return existing }
    let created = PixelBufferFactory(width: width, height: height, pixelFormat: format)
    pools[key] = created
    return created
  }

  private func checkOutSession(scalingMode: CFString) -> VTPixelTransferSession? {
    lock.lock()
    if var available = idleSessions[scalingMode], let session = available.popLast() {
      idleSessions[scalingMode] = available
      lock.unlock()
      return session
    }
    lock.unlock()

    var created: VTPixelTransferSession?
    guard VTPixelTransferSessionCreate(
      allocator: kCFAllocatorDefault,
      pixelTransferSessionOut: &created
    ) == noErr, let created else { return nil }

    VTSessionSetProperty(created, key: kVTPixelTransferPropertyKey_ScalingMode, value: scalingMode)
    VTSessionSetProperty(created, key: kVTPixelTransferPropertyKey_RealTime, value: kCFBooleanTrue)
    return created
  }

  private func checkIn(_ session: VTPixelTransferSession, scalingMode: CFString) {
    lock.lock()
    idleSessions[scalingMode, default: []].append(session)
    lock.unlock()
  }
}
