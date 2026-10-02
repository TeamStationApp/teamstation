import CoreVideo
import Foundation

/// One black picture per capture format, so blanking costs nothing per frame.
///
/// Shared by the encoder and the external-display feed: both substitute black for the live picture
/// when video is off, and both must produce a buffer the consumer accepts as if it had come from the
/// camera, which means the same dimensions and pixel format rather than a generic black image.
public struct BlackFrameCache {
  private var buffer: CVPixelBuffer?

  public init() {}

  /// The cached buffer when it already matches `imageBuffer`, otherwise a fresh one.
  public mutating func buffer(matching imageBuffer: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(imageBuffer)
    let height = CVPixelBufferGetHeight(imageBuffer)
    let format = CVPixelBufferGetPixelFormatType(imageBuffer)
    if let existing = buffer,
      CVPixelBufferGetWidth(existing) == width,
      CVPixelBufferGetHeight(existing) == height,
      CVPixelBufferGetPixelFormatType(existing) == format
    {
      return existing
    }
    var created: CVPixelBuffer?
    let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, format, nil, &created)
    guard status == kCVReturnSuccess, let created else { return nil }
    Self.fillBlack(created)
    buffer = created
    return created
  }

  /// Video-range luma black is 16, not 0; a zeroed buffer would encode as a slightly illegal
  /// "blacker than black" and some displays clip it visibly.
  static func fillBlack(_ buffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let format = CVPixelBufferGetPixelFormatType(buffer)
    let videoRange = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    let biplanar = videoRange || format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    if biplanar {
      if let y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
          * CVPixelBufferGetHeightOfPlane(buffer, 0)
        y.assumingMemoryBound(to: UInt8.self).update(repeating: videoRange ? 16 : 0, count: bytes)
      }
      if let uv = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
          * CVPixelBufferGetHeightOfPlane(buffer, 1)
        uv.assumingMemoryBound(to: UInt8.self).update(repeating: 128, count: bytes)
      }
      return
    }
    if let base = CVPixelBufferGetBaseAddress(buffer) {
      let bytes = CVPixelBufferGetBytesPerRow(buffer) * CVPixelBufferGetHeight(buffer)
      base.assumingMemoryBound(to: UInt8.self).update(repeating: 0, count: bytes)
    }
  }
}
