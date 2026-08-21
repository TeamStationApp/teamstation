import CoreGraphics
import CoreVideo
import Foundation

/// Turns CoreGraphics images into pixel buffers so proxy stills and the scorebug snapshot can
/// travel the same path as camera frames.
public enum PixelBufferDrawing {
  public static func makeBGRA(from image: CGImage, width: Int? = nil, height: Int? = nil) -> CVPixelBuffer? {
    let targetWidth = width ?? image.width
    let targetHeight = height ?? image.height

    var pixelBuffer: CVPixelBuffer?
    let attributes: [String: Any] = [
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      kCVPixelBufferMetalCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]
    guard CVPixelBufferCreate(
      kCFAllocatorDefault,
      targetWidth,
      targetHeight,
      kCVPixelFormatType_32BGRA,
      attributes as CFDictionary,
      &pixelBuffer
    ) == kCVReturnSuccess, let pixelBuffer else { return nil }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

    guard
      let base = CVPixelBufferGetBaseAddress(pixelBuffer),
      let context = CGContext(
        data: base,
        width: targetWidth,
        height: targetHeight,
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
      )
    else { return nil }

    context.clear(CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
    context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
    return pixelBuffer
  }
}
