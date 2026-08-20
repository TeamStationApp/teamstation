import CoreGraphics
import CoreVideo
import Foundation

/// A frame number encoded as a strip of black/white blocks in the top-left corner.
///
/// This is the ground truth for R4. A frame is generated with its ID painted into the picture,
/// travels through conversion, encoding, segmentation and back out through a decoder, and the
/// ID is read out of the decoded pixels. If it survives, that frame really is that frame — no
/// metadata bookkeeping can fake it.
///
/// Blocks are large and pure black or pure white so ordinary inter-frame compression cannot
/// smear a bit across the threshold.
public enum FrameMarker {
  public static let bitCount = 20
  public static let cellSize = 24
  public static let cellStride = 32
  public static let originX = 8
  public static let originY = 8
  /// Sentinel, then `bitCount` data cells, then sentinel.
  public static let cellCount = bitCount + 2
  public static let stripWidth = originX + cellCount * cellStride
  public static let stripHeight = originY + cellSize + originY

  public static let maximumValue = (1 << bitCount) - 1

  /// Centre point of cell `index` in pixels, used by both the painter and the reader.
  public static func cellCenter(_ index: Int) -> (x: Int, y: Int) {
    (
      x: originX + index * cellStride + cellSize / 2,
      y: originY + cellSize / 2
    )
  }

  /// Paints the marker for `value` into a CoreGraphics context whose origin is top-left.
  public static func draw(value: Int, in context: CGContext) {
    let wrapped = value & maximumValue
    for index in 0 ..< cellCount {
      let isWhite: Bool
      switch index {
      case 0: isWhite = true
      case cellCount - 1: isWhite = false
      default: isWhite = (wrapped >> (index - 1)) & 1 == 1
      }
      context.setFillColor(gray: isWhite ? 1 : 0, alpha: 1)
      context.fill(CGRect(
        x: originX + index * cellStride,
        y: originY,
        width: cellSize,
        height: cellSize
      ))
    }
  }

  /// Reads a marker back out of a BGRA or 32-bit RGB pixel buffer.
  /// Returns `nil` when the sentinels do not match, which is how a frame without a marker —
  /// a real camera frame — is distinguished from a corrupted one.
  public static func read(from pixelBuffer: CVPixelBuffer) -> Int? {
    let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
    guard format == kCVPixelFormatType_32BGRA || format == kCVPixelFormatType_32ARGB else { return nil }
    guard CVPixelBufferGetWidth(pixelBuffer) >= stripWidth,
          CVPixelBufferGetHeight(pixelBuffer) >= stripHeight else { return nil }

    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let bytes = base.assumingMemoryBound(to: UInt8.self)

    func luminance(atX x: Int, y: Int) -> Int {
      let pixel = bytes + y * bytesPerRow + x * 4
      // Both layouts put the three colour bytes adjacent; averaging is enough for a
      // black-or-white decision and avoids branching on channel order.
      return (Int(pixel[0]) + Int(pixel[1]) + Int(pixel[2]) + Int(pixel[3])) / 4
    }

    var bits = 0
    for index in 0 ..< cellCount {
      let centre = cellCenter(index)
      let value = luminance(atX: centre.x, y: centre.y)
      let isWhite = value > 128
      switch index {
      case 0:
        guard isWhite else { return nil }
      case cellCount - 1:
        guard !isWhite else { return nil }
      default:
        if isWhite { bits |= 1 << (index - 1) }
      }
    }
    return bits
  }
}
