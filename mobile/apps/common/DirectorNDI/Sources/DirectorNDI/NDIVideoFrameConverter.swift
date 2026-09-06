import CNDI
import CoreVideo
import Foundation
import DirectorSources

/// Copies an NDI video frame into a pooled `CVPixelBuffer` the rest of the pipeline understands.
///
/// The receiver asks the SDK for `NDIlib_recv_color_format_fastest`, which the documentation says
/// is the high-performance path and which yields 8-bit UYVY on this platform. Everything else here
/// exists because a *sender* may choose otherwise: NDI|HX senders produce 4:2:0 planar layouts, and
/// software senders such as a screen capture produce BGRA.
///
/// Two rules the whole file follows:
///
/// - **The destination is always pooled.** `PixelBufferFactory` caps its pool, and a miss drops the
///   frame rather than growing until jetsam — the failure that once turned a 20-second recording
///   into an 850 MB process.
/// - **The source stride is never assumed to be packed.** `line_stride_in_bytes` is routinely
///   larger than the row, and a converter that ignores it produces a picture that shears
///   progressively down the frame — which reads as a decode bug rather than a copy bug.
public final class NDIVideoFrameConverter: @unchecked Sendable {
  /// What the rest of the pipeline runs on. `PixelConverter` will take this straight through to
  /// the encoder and the compositor without a second conversion.
  public static let outputPixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

  private let lock = NSLock()
  private var factory: PixelBufferFactory?
  private var factoryWidth = 0
  private var factoryHeight = 0

  public init() {}

  /// Returns nil when no buffer was available or the layout could not be read. Both are counted by
  /// the caller as separate things: a pool miss is our own backlog, an unreadable layout is the
  /// camera's.
  public func convert(_ frame: NDIlib_video_frame_v2_t) -> CVPixelBuffer? {
    let width = Int(frame.xres)
    let height = Int(frame.yres)
    guard let source = frame.p_data else { return nil }
    let stride = Int(frame.line_stride_in_bytes)

    guard let destination = buffer(width: width, height: height) else { return nil }
    guard CVPixelBufferLockBaseAddress(destination, []) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(destination, []) }

    guard
      let luma = CVPixelBufferGetBaseAddressOfPlane(destination, 0),
      let chroma = CVPixelBufferGetBaseAddressOfPlane(destination, 1)
    else { return nil }
    let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(destination, 0)
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(destination, 1)

    switch frame.FourCC {
    case NDIlib_FourCC_video_type_UYVY:
      convertUYVY(
        source: source, sourceStride: stride,
        luma: luma, lumaStride: lumaStride,
        chroma: chroma, chromaStride: chromaStride,
        width: width, height: height
      )

    case NDIlib_FourCC_video_type_NV12:
      // Already the destination layout; only the strides differ.
      copyPlane(
        from: source, stride: stride,
        to: luma, toStride: lumaStride,
        rowBytes: width, rows: height
      )
      copyPlane(
        from: source.advanced(by: stride * height), stride: stride,
        to: chroma, toStride: chromaStride,
        rowBytes: width, rows: height / 2
      )

    case NDIlib_FourCC_video_type_I420, NDIlib_FourCC_video_type_YV12:
      // The SDK's own documentation gives I420 and YV12 the *same* plane arithmetic — V after Y,
      // then U — so both are read that way and the two chroma planes are interleaved into NV12.
      // Treating I420 as U-then-V here swaps the red and blue difference channels, which shows up
      // as a picture with the right luma and inverted colour rather than as an obvious failure.
      let vPlane = source.advanced(by: stride * height)
      let uPlane = vPlane.advanced(by: (stride / 2) * (height / 2))
      interleaveChroma(
        first: uPlane, second: vPlane, sourceStride: stride / 2,
        chroma: chroma, chromaStride: chromaStride,
        width: width, height: height
      )
      copyPlane(
        from: source, stride: stride,
        to: luma, toStride: lumaStride,
        rowBytes: width, rows: height
      )

    case NDIlib_FourCC_video_type_BGRA, NDIlib_FourCC_video_type_BGRX,
         NDIlib_FourCC_video_type_RGBA, NDIlib_FourCC_video_type_RGBX:
      guard convertRGB(
        source: source, sourceStride: stride, fourCC: frame.FourCC,
        luma: luma, lumaStride: lumaStride,
        chroma: chroma, chromaStride: chromaStride,
        width: width, height: height
      ) else { return nil }

    default:
      return nil
    }

    return destination
  }

  // MARK: - Destination

  private func buffer(width: Int, height: Int) -> CVPixelBuffer? {
    lock.lock()
    defer { lock.unlock() }
    if factory == nil || factoryWidth != width || factoryHeight != height {
      factory = PixelBufferFactory(
        width: width,
        height: height,
        pixelFormat: Self.outputPixelFormat
      )
      factoryWidth = width
      factoryHeight = height
    }
    return factory?.makeBuffer()
  }

  // MARK: - Layouts

  /// UYVY 4:2:2 → NV12 4:2:0.
  ///
  /// Luma is every second byte. Chroma is subsampled vertically by dropping the odd lines rather
  /// than averaging them: the pair costs a read and an add per sample at 1080p60 across four
  /// cameras, and the result goes into a lossy encoder either way. Dropping is what the SDK's own
  /// fast path does.
  private func convertUYVY(
    source: UnsafeRawPointer, sourceStride: Int,
    luma: UnsafeMutableRawPointer, lumaStride: Int,
    chroma: UnsafeMutableRawPointer, chromaStride: Int,
    width: Int, height: Int
  ) {
    for row in 0 ..< height {
      let input = source.advanced(by: row * sourceStride).assumingMemoryBound(to: UInt8.self)
      let output = luma.advanced(by: row * lumaStride).assumingMemoryBound(to: UInt8.self)
      for column in 0 ..< width {
        output[column] = input[column * 2 + 1]
      }
      guard row % 2 == 0 else { continue }
      let chromaRow = chroma
        .advanced(by: (row / 2) * chromaStride)
        .assumingMemoryBound(to: UInt8.self)
      for pair in 0 ..< (width / 2) {
        chromaRow[pair * 2] = input[pair * 4]       // U
        chromaRow[pair * 2 + 1] = input[pair * 4 + 2] // V
      }
    }
  }

  private func copyPlane(
    from source: UnsafeRawPointer, stride: Int,
    to destination: UnsafeMutableRawPointer, toStride: Int,
    rowBytes: Int, rows: Int
  ) {
    if stride == toStride && stride == rowBytes {
      memcpy(destination, source, rowBytes * rows)
      return
    }
    for row in 0 ..< rows {
      memcpy(
        destination.advanced(by: row * toStride),
        source.advanced(by: row * stride),
        rowBytes
      )
    }
  }

  private func interleaveChroma(
    first: UnsafeRawPointer, second: UnsafeRawPointer, sourceStride: Int,
    chroma: UnsafeMutableRawPointer, chromaStride: Int,
    width: Int, height: Int
  ) {
    let halfWidth = width / 2
    for row in 0 ..< (height / 2) {
      let u = first.advanced(by: row * sourceStride).assumingMemoryBound(to: UInt8.self)
      let v = second.advanced(by: row * sourceStride).assumingMemoryBound(to: UInt8.self)
      let output = chroma.advanced(by: row * chromaStride).assumingMemoryBound(to: UInt8.self)
      for column in 0 ..< halfWidth {
        output[column * 2] = u[column]
        output[column * 2 + 1] = v[column]
      }
    }
  }

  /// 32-bit RGB → NV12, Rec.709 video range.
  ///
  /// Written out rather than handed to vImage. The framework exposes its conversion matrices as
  /// mutable globals, which Swift 6 refuses to read from a concurrent context, and the ways around
  /// that are all worse than twenty lines of arithmetic. This path carries software senders — a
  /// screen capture or a graphics feed — rather than the cameras, which arrive as UYVY.
  ///
  /// Rec.709 because the SDK documents the colour space by resolution: SD is 601, HD is 709. Using
  /// 601 here would tint every software sender.
  private func convertRGB(
    source: UnsafeRawPointer, sourceStride: Int, fourCC: NDIlib_FourCC_video_type_e,
    luma: UnsafeMutableRawPointer, lumaStride: Int,
    chroma: UnsafeMutableRawPointer, chromaStride: Int,
    width: Int, height: Int
  ) -> Bool {
    // BGRA and BGRX are B,G,R,A in memory; RGBA and RGBX are R,G,B,A. The X variants carry 255 in
    // the fourth byte and are otherwise identical, which is why alpha is never read.
    let isBGR = fourCC == NDIlib_FourCC_video_type_BGRA || fourCC == NDIlib_FourCC_video_type_BGRX
    let redOffset = isBGR ? 2 : 0
    let blueOffset = isBGR ? 0 : 2

    for row in 0 ..< height {
      let input = source.advanced(by: row * sourceStride).assumingMemoryBound(to: UInt8.self)
      let lumaRow = luma.advanced(by: row * lumaStride).assumingMemoryBound(to: UInt8.self)
      let wantsChroma = row % 2 == 0
      let chromaRow = wantsChroma
        ? chroma.advanced(by: (row / 2) * chromaStride).assumingMemoryBound(to: UInt8.self)
        : nil

      for column in 0 ..< width {
        let base = column * 4
        let red = Double(input[base + redOffset])
        let green = Double(input[base + 1])
        let blue = Double(input[base + blueOffset])

        let y = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        lumaRow[column] = UInt8(clamping: Int(16 + y * 219 / 255))

        // Chroma is sampled from the even column of each even row rather than averaged over the
        // 2x2 quad. It is what the SDK's own fast path does, and the result goes straight into a
        // lossy encoder.
        guard let chromaRow, column % 2 == 0 else { continue }
        let cb = (blue - y) / 1.8556
        let cr = (red - y) / 1.5748
        chromaRow[column] = UInt8(clamping: Int(128 + cb * 224 / 255))
        chromaRow[column + 1] = UInt8(clamping: Int(128 + cr * 224 / 255))
      }
    }
    return true
  }
}
