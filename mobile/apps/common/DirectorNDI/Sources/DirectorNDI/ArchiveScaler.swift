import CoreVideo
import Foundation
import VideoToolbox

/// Fits an NDI camera's pictures to the raw camera resolution before they are archived.
///
/// The archive is encoded at one size from Settings, whatever the camera sends. A camera that
/// changes resolution mid-take therefore no longer changes the recording's format, which used to
/// cost a new archive writer, and every camera's recording comes out the size the operator chose. A
/// picture of another shape is fitted inside the frame with black bars, never stretched or cropped.
public final class ArchiveScaler: @unchecked Sendable {
  public let width: Int
  public let height: Int
  private let session: VTPixelTransferSession
  private let pool: CVPixelBufferPool

  public init?(width: Int, height: Int) {
    self.width = width
    self.height = height
    var created: VTPixelTransferSession?
    guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &created) == noErr,
          let session = created
    else { return nil }
    VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox)
    var madePool: CVPixelBufferPool?
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey: width,
      kCVPixelBufferHeightKey: height,
      kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()
    ]
    guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &madePool) == kCVReturnSuccess,
          let pool = madePool
    else {
      VTPixelTransferSessionInvalidate(session)
      return nil
    }
    self.session = session
    self.pool = pool
  }

  deinit {
    VTPixelTransferSessionInvalidate(session)
  }

  /// `buffer` at this scaler's size: the buffer itself when it is already that size, otherwise a
  /// scaled copy, or nil when the copy could not be made.
  public func scale(_ buffer: CVPixelBuffer) -> CVPixelBuffer? {
    let sourceWidth = CVPixelBufferGetWidth(buffer)
    let sourceHeight = CVPixelBufferGetHeight(buffer)
    if sourceWidth == width, sourceHeight == height { return buffer }
    var made: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) == kCVReturnSuccess, let output = made else {
      return nil
    }
    // A picture of another shape leaves bars the transfer does not paint, and a pooled buffer holds
    // whatever its last use left there. Black, in video range: luma 16, chroma 128.
    if sourceWidth * height != sourceHeight * width { Self.fillBlack(output) }
    guard VTPixelTransferSessionTransferImage(session, from: buffer, to: output) == noErr else { return nil }
    return output
  }

  private static func fillBlack(_ buffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    for plane in 0 ..< CVPixelBufferGetPlaneCount(buffer) {
      guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) else { continue }
      let bytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane)
      memset(base, plane == 0 ? 16 : 128, bytes)
    }
  }
}
