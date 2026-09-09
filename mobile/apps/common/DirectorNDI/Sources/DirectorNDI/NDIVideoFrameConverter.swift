import Accelerate
import CNDI
import CoreVideo
import Foundation
import DirectorSources

/// Copies an NDI video frame into a pooled `CVPixelBuffer` of the *same* pixel format.
///
/// This deliberately does not change pixel format. `PixelConverter` already normalises whatever a
/// source delivers into the bi-planar 4:2:0 the encoders and the compositor want — once per frame,
/// shared by preview, proxy and archive, through `VTPixelTransferSession`, which is hardware. A
/// conversion here would duplicate that work, and a hand-written one at that.
///
/// The first version of this file did convert, with a per-pixel loop, and it ran a four-camera
/// fleet at **2.3 fps of a requested 30**. It is the lesson `SyntheticFrameSource.fillNoise`
/// already records: these buffers are IOSurface-backed and individual writes to that memory are
/// enormously slower than bulk copies. Everything below is a `memcpy` per row or per plane, and
/// nothing touches an individual pixel.
///
/// Two rules the file follows:
///
/// - **The destination is always pooled.** `PixelBufferFactory` caps its pool, and a miss drops the
///   frame rather than growing until jetsam — the failure that once turned a 20-second recording
///   into an 850 MB process.
/// - **The source stride is never assumed to be packed.** `line_stride_in_bytes` is routinely
///   larger than the row, and a copy that ignores it shears the picture progressively down the
///   frame, which reads as a decode bug rather than a copy bug.
public final class NDIVideoFrameConverter: @unchecked Sendable {
  private let lock = NSLock()
  private var factory: PixelBufferFactory?
  private var factoryWidth = 0
  private var factoryHeight = 0
  private var factoryFormat: OSType = 0

  public init() {}

  /// The `CVPixelBuffer` format an NDI layout is copied into, or nil for one this app does not
  /// carry.
  ///
  /// Each is the CoreVideo type with the *same* memory layout as the NDI one, so the copy moves
  /// bytes and `PixelConverter` is handed something VideoToolbox converts natively.
  public static func pixelFormat(for fourCC: NDIlib_FourCC_video_type_e) -> OSType? {
    switch fourCC {
    // UYVA is UYVY with an alpha plane after it. The programme composites over its own background,
    // so that plane is left behind rather than carried.
    case NDIlib_FourCC_video_type_UYVY, NDIlib_FourCC_video_type_UYVA:
      kCVPixelFormatType_422YpCbCr8
    case NDIlib_FourCC_video_type_NV12:
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    case NDIlib_FourCC_video_type_I420, NDIlib_FourCC_video_type_YV12:
      kCVPixelFormatType_420YpCbCr8Planar
    // BGRX carries 255 in its fourth byte, so it is byte-identical to BGRA and the alpha is simply
    // never read.
    case NDIlib_FourCC_video_type_BGRA, NDIlib_FourCC_video_type_BGRX:
      kCVPixelFormatType_32BGRA
    // Not `kCVPixelFormatType_32RGBA`: CoreVideo will not back a pool with it here, so the copy
    // returned nothing at all. The bytes are permuted into BGRA instead, which is the format the
    // rest of the platform actually wants.
    case NDIlib_FourCC_video_type_RGBA, NDIlib_FourCC_video_type_RGBX:
      kCVPixelFormatType_32BGRA
    default:
      nil
    }
  }

  /// Returns nil when no buffer was available or the layout is one this app does not carry. The
  /// caller counts those separately: a pool miss is our own backlog, an unhandled layout is the
  /// camera's.
  public func convert(_ frame: NDIlib_video_frame_v2_t) -> CVPixelBuffer? {
    let width = Int(frame.xres)
    let height = Int(frame.yres)
    guard
      let source = UnsafeRawPointer(frame.p_data),
      let format = Self.pixelFormat(for: frame.FourCC),
      let destination = buffer(width: width, height: height, format: format)
    else { return nil }

    let stride = Int(frame.line_stride_in_bytes)
    guard CVPixelBufferLockBaseAddress(destination, []) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(destination, []) }

    switch frame.FourCC {
    case NDIlib_FourCC_video_type_UYVY, NDIlib_FourCC_video_type_UYVA,
         NDIlib_FourCC_video_type_BGRA, NDIlib_FourCC_video_type_BGRX:
      guard let base = CVPixelBufferGetBaseAddress(destination) else { return nil }
      copyPlane(
        from: source, stride: stride,
        to: base, toStride: CVPixelBufferGetBytesPerRow(destination),
        rowBytes: NDIFrameValidator.minimumStride(for: frame.FourCC, width: width),
        rows: height
      )

    case NDIlib_FourCC_video_type_RGBA, NDIlib_FourCC_video_type_RGBX:
      guard
        let base = CVPixelBufferGetBaseAddress(destination),
        permuteToBGRA(
          from: source, stride: stride,
          to: base, toStride: CVPixelBufferGetBytesPerRow(destination),
          width: width, height: height
        )
      else { return nil }

    case NDIlib_FourCC_video_type_NV12:
      guard
        let luma = CVPixelBufferGetBaseAddressOfPlane(destination, 0),
        let chroma = CVPixelBufferGetBaseAddressOfPlane(destination, 1)
      else { return nil }
      copyPlane(
        from: source, stride: stride,
        to: luma, toStride: CVPixelBufferGetBytesPerRowOfPlane(destination, 0),
        rowBytes: width, rows: height
      )
      copyPlane(
        from: source.advanced(by: stride * height), stride: stride,
        to: chroma, toStride: CVPixelBufferGetBytesPerRowOfPlane(destination, 1),
        rowBytes: width, rows: height / 2
      )

    case NDIlib_FourCC_video_type_I420, NDIlib_FourCC_video_type_YV12:
      // Standard plane orders: I420 is Y, U, V and YV12 is Y, V, U. The SDK's own documentation
      // gives both the same arithmetic, which cannot be right for both names, so the universal
      // definitions are used. If the documentation is right instead, the only consequence is red
      // and blue swapping on one of the two. Untested against real NDI|HX hardware.
      guard
        let luma = CVPixelBufferGetBaseAddressOfPlane(destination, 0),
        let cb = CVPixelBufferGetBaseAddressOfPlane(destination, 1),
        let cr = CVPixelBufferGetBaseAddressOfPlane(destination, 2)
      else { return nil }
      let chromaStride = stride / 2
      let chromaRows = height / 2
      let first = source.advanced(by: stride * height)
      let second = first.advanced(by: chromaStride * chromaRows)
      let isYV12 = frame.FourCC == NDIlib_FourCC_video_type_YV12

      copyPlane(
        from: source, stride: stride,
        to: luma, toStride: CVPixelBufferGetBytesPerRowOfPlane(destination, 0),
        rowBytes: width, rows: height
      )
      copyPlane(
        from: isYV12 ? second : first, stride: chromaStride,
        to: cb, toStride: CVPixelBufferGetBytesPerRowOfPlane(destination, 1),
        rowBytes: width / 2, rows: chromaRows
      )
      copyPlane(
        from: isYV12 ? first : second, stride: chromaStride,
        to: cr, toStride: CVPixelBufferGetBytesPerRowOfPlane(destination, 2),
        rowBytes: width / 2, rows: chromaRows
      )

    default:
      return nil
    }

    return destination
  }

  /// Bytes one source may hold in decoded pictures, delay line included.
  static let poolByteBudget = 256 * 1024 * 1024
  /// Two bytes a pixel is UYVY, the format `NDIlib_recv_color_format_fastest` delivers here.
  static func poolSize(width: Int, height: Int) -> Int {
    let bytesPerFrame = max(1, width * height * 2)
    return max(16, min(150, poolByteBudget / bytesPerFrame))
  }

  /// What the current pool can lend, for a delay line that must not outgrow it.
  var maximumBuffers: Int {
    lock.lock()
    defer { lock.unlock() }
    return factory?.maximumBuffers ?? Self.poolSize(width: 1920, height: 1080)
  }

  private func buffer(width: Int, height: Int, format: OSType) -> CVPixelBuffer? {
    lock.lock()
    defer { lock.unlock() }
    if factory == nil || factoryWidth != width || factoryHeight != height || factoryFormat != format {
      // Sized for the delay line, not just for in-flight frames — a pool of 32 starved a half-second
      // line into `poolMisses` — but bounded in bytes, not frames. NDI has no compressed form, so
      // what the line holds is decoded pixels: at 1080p that is about 4 MB a frame, and a count
      // chosen for the 2 s ceiling would let three cameras hold well over a gigabyte between them.
      // The budget gives 1080p about a second at 60 fps; the line is capped to the pool so it never
      // asks for more than this.
      factory = PixelBufferFactory(
        width: width,
        height: height,
        pixelFormat: format,
        maximumBuffers: Self.poolSize(width: width, height: height)
      )
      factoryWidth = width
      factoryHeight = height
      factoryFormat = format
    }
    return factory?.makeBuffer()
  }

  /// R,G,B,A in memory to B,G,R,A. A channel swap rather than a colour conversion, so vImage does
  /// it in one pass with a constant permute map and nothing here touches an individual pixel.
  private func permuteToBGRA(
    from source: UnsafeRawPointer, stride: Int,
    to destination: UnsafeMutableRawPointer, toStride: Int,
    width: Int, height: Int
  ) -> Bool {
    var input = vImage_Buffer(
      data: UnsafeMutableRawPointer(mutating: source),
      height: vImagePixelCount(height),
      width: vImagePixelCount(width),
      rowBytes: stride
    )
    var output = vImage_Buffer(
      data: destination,
      height: vImagePixelCount(height),
      width: vImagePixelCount(width),
      rowBytes: toStride
    )
    let map: [UInt8] = [ 2, 1, 0, 3 ]
    return vImagePermuteChannels_ARGB8888(
      &input, &output, map, vImage_Flags(kvImageDoNotTile)
    ) == kvImageNoError
  }

  /// One `memcpy` when the strides agree, one per row when they do not. Never a loop over pixels.
  private func copyPlane(
    from source: UnsafeRawPointer, stride: Int,
    to destination: UnsafeMutableRawPointer, toStride: Int,
    rowBytes: Int, rows: Int
  ) {
    guard rows > 0, rowBytes > 0 else { return }
    if stride == toStride, stride == rowBytes {
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
}
