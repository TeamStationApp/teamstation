import CNDI
import CoreVideo
import XCTest
@testable import DirectorNDI

/// The copy from an NDI frame into a `CVPixelBuffer`.
///
/// Two things are being pinned. The destination must be a CoreVideo format with the *same* memory
/// layout as the NDI one, because the pipeline's shared `PixelConverter` does the actual colour
/// conversion in hardware and a second conversion here cost the fleet its frame rate once already.
/// And the source stride must be honoured: senders pad rows routinely, and a copy that assumes
/// packed data shears the picture progressively down the frame.
final class NDIVideoFrameConverterTests: XCTestCase {
  private let width = 64
  private let height = 32

  /// Builds a source frame whose bytes are a known pattern, so the copy can be checked rather than
  /// merely observed to have happened.
  private func makeFrame(
    fourCC: NDIlib_FourCC_video_type_e,
    padding: Int = 0,
    fill: (UnsafeMutablePointer<UInt8>, Int) -> Void
  ) -> (NDIlib_video_frame_v2_t, UnsafeMutablePointer<UInt8>) {
    let rowBytes = NDIFrameValidator.minimumStride(for: fourCC, width: width)
    let stride = rowBytes + padding
    // Generous: enough for three planes at full height, whatever the layout.
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: stride * height * 3)
    buffer.initialize(repeating: 0, count: stride * height * 3)
    fill(buffer, stride)

    var frame = NDIlib_video_frame_v2_t()
    frame.xres = Int32(width)
    frame.yres = Int32(height)
    frame.FourCC = fourCC
    frame.frame_rate_N = 30_000
    frame.frame_rate_D = 1_000
    frame.frame_format_type = NDIlib_frame_format_type_progressive
    frame.line_stride_in_bytes = Int32(stride)
    frame.p_data = buffer
    return (frame, buffer)
  }

  func testEachLayoutLandsInAMatchingPixelBuffer() {
    let expected: [(NDIlib_FourCC_video_type_e, OSType)] = [
      (NDIlib_FourCC_video_type_UYVY, kCVPixelFormatType_422YpCbCr8),
      (NDIlib_FourCC_video_type_UYVA, kCVPixelFormatType_422YpCbCr8),
      (NDIlib_FourCC_video_type_NV12, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
      (NDIlib_FourCC_video_type_I420, kCVPixelFormatType_420YpCbCr8Planar),
      (NDIlib_FourCC_video_type_YV12, kCVPixelFormatType_420YpCbCr8Planar),
      (NDIlib_FourCC_video_type_BGRA, kCVPixelFormatType_32BGRA),
      (NDIlib_FourCC_video_type_BGRX, kCVPixelFormatType_32BGRA),
      // RGBA is permuted to BGRA rather than kept: CoreVideo will not back a pool with
      // kCVPixelFormatType_32RGBA, so keeping it produced no buffer at all.
      (NDIlib_FourCC_video_type_RGBA, kCVPixelFormatType_32BGRA),
      (NDIlib_FourCC_video_type_RGBX, kCVPixelFormatType_32BGRA)
    ]
    for (fourCC, format) in expected {
      XCTAssertEqual(NDIVideoFrameConverter.pixelFormat(for: fourCC), format)

      let converter = NDIVideoFrameConverter()
      let (frame, buffer) = makeFrame(fourCC: fourCC) { _, _ in }
      defer { buffer.deallocate() }

      guard let converted = converter.convert(frame) else {
        return XCTFail("could not copy a \(fourCC) frame")
      }
      XCTAssertEqual(CVPixelBufferGetPixelFormatType(converted), format)
      XCTAssertEqual(CVPixelBufferGetWidth(converted), width)
      XCTAssertEqual(CVPixelBufferGetHeight(converted), height)
    }
  }

  func testUnhandledLayoutIsRefusedRatherThanGuessedAt() {
    XCTAssertNil(NDIVideoFrameConverter.pixelFormat(for: NDIlib_FourCC_video_type_P216))
    let converter = NDIVideoFrameConverter()
    let (frame, buffer) = makeFrame(fourCC: NDIlib_FourCC_video_type_P216) { _, _ in }
    defer { buffer.deallocate() }
    XCTAssertNil(converter.convert(frame))
  }

  /// The picture has to survive the copy byte for byte. A UYVY row is written with a distinct
  /// value per column so a shear, an offset or a dropped row all show up.
  func testUYVYPixelsArriveIntact() {
    let converter = NDIVideoFrameConverter()
    let (frame, buffer) = makeFrame(fourCC: NDIlib_FourCC_video_type_UYVY) { data, stride in
      for row in 0 ..< self.height {
        for byte in 0 ..< self.width * 2 {
          data[row * stride + byte] = UInt8((row &* 7 &+ byte) & 0xFF)
        }
      }
    }
    defer { buffer.deallocate() }

    guard let converted = converter.convert(frame) else { return XCTFail("copy failed") }
    CVPixelBufferLockBaseAddress(converted, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(converted, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(converted) else { return XCTFail("no address") }
    let destinationStride = CVPixelBufferGetBytesPerRow(converted)

    for row in [ 0, height / 2, height - 1 ] {
      let line = base.advanced(by: row * destinationStride).assumingMemoryBound(to: UInt8.self)
      for byte in [ 0, width, width * 2 - 1 ] {
        XCTAssertEqual(
          line[byte],
          UInt8((row &* 7 &+ byte) & 0xFF),
          "row \(row) byte \(byte) did not survive the copy"
        )
      }
    }
  }

  /// Padded rows are the normal case, not the exception. A copy that ignores the stride reads the
  /// padding as picture and every row lands a little further out than the last.
  func testPaddedSourceStrideIsHonoured() {
    let converter = NDIVideoFrameConverter()
    let (frame, buffer) = makeFrame(fourCC: NDIlib_FourCC_video_type_UYVY, padding: 96) { data, stride in
      for row in 0 ..< self.height {
        // Picture bytes carry the row number; the padding carries something else entirely, so
        // reading it as picture is unmistakable.
        for byte in 0 ..< self.width * 2 { data[row * stride + byte] = UInt8(row & 0xFF) }
        for byte in self.width * 2 ..< stride { data[row * stride + byte] = 0xEE }
      }
    }
    defer { buffer.deallocate() }

    guard let converted = converter.convert(frame) else { return XCTFail("copy failed") }
    CVPixelBufferLockBaseAddress(converted, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(converted, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(converted) else { return XCTFail("no address") }
    let destinationStride = CVPixelBufferGetBytesPerRow(converted)

    for row in 0 ..< height {
      let line = base.advanced(by: row * destinationStride).assumingMemoryBound(to: UInt8.self)
      XCTAssertEqual(line[0], UInt8(row & 0xFF), "row \(row) came from the wrong offset")
      XCTAssertNotEqual(line[0], 0xEE, "row \(row) read the source's padding as picture")
    }
  }

  /// The luma plane of an NV12 frame has to land in plane 0 unchanged; the chroma plane follows it
  /// in the source at `stride * height`, which is the arithmetic most easily got wrong.
  func testNV12PlanesLandInTheRightOrder() {
    let converter = NDIVideoFrameConverter()
    let (frame, buffer) = makeFrame(fourCC: NDIlib_FourCC_video_type_NV12) { data, stride in
      for row in 0 ..< self.height {
        for byte in 0 ..< self.width { data[row * stride + byte] = 0x40 }
      }
      for row in 0 ..< self.height / 2 {
        for byte in 0 ..< self.width { data[(self.height + row) * stride + byte] = 0x90 }
      }
    }
    defer { buffer.deallocate() }

    guard let converted = converter.convert(frame) else { return XCTFail("copy failed") }
    CVPixelBufferLockBaseAddress(converted, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(converted, .readOnly) }

    guard
      let luma = CVPixelBufferGetBaseAddressOfPlane(converted, 0),
      let chroma = CVPixelBufferGetBaseAddressOfPlane(converted, 1)
    else { return XCTFail("no planes") }
    XCTAssertEqual(luma.assumingMemoryBound(to: UInt8.self)[0], 0x40)
    XCTAssertEqual(chroma.assumingMemoryBound(to: UInt8.self)[0], 0x90)
  }

  /// I420 and YV12 differ only in which chroma plane comes first, and getting it backwards swaps
  /// red and blue — a picture that looks plausible until someone notices the grass is purple.
  func testI420AndYV12PutChromaInOppositePlanes() {
    for fourCC in [ NDIlib_FourCC_video_type_I420, NDIlib_FourCC_video_type_YV12 ] {
      let converter = NDIVideoFrameConverter()
      let (frame, buffer) = makeFrame(fourCC: fourCC) { data, stride in
        let chromaStride = stride / 2
        let chromaRows = self.height / 2
        for row in 0 ..< chromaRows {
          for byte in 0 ..< self.width / 2 {
            data[stride * self.height + row * chromaStride + byte] = 0x11
            data[stride * self.height + chromaStride * chromaRows + row * chromaStride + byte] = 0x22
          }
        }
      }
      defer { buffer.deallocate() }

      guard let converted = converter.convert(frame) else { return XCTFail("copy failed") }
      CVPixelBufferLockBaseAddress(converted, .readOnly)
      defer { CVPixelBufferUnlockBaseAddress(converted, .readOnly) }
      guard
        let cb = CVPixelBufferGetBaseAddressOfPlane(converted, 1),
        let cr = CVPixelBufferGetBaseAddressOfPlane(converted, 2)
      else { return XCTFail("no chroma planes") }

      // I420 is Y, U, V — so the first source chroma plane is Cb. YV12 is Y, V, U — so it is Cr.
      let isI420 = fourCC == NDIlib_FourCC_video_type_I420
      XCTAssertEqual(cb.assumingMemoryBound(to: UInt8.self)[0], isI420 ? 0x11 : 0x22)
      XCTAssertEqual(cr.assumingMemoryBound(to: UInt8.self)[0], isI420 ? 0x22 : 0x11)
    }
  }

  /// R,G,B,A on the wire has to arrive as B,G,R,A, or every software sender's picture comes out
  /// with red and blue swapped.
  func testRGBAIsPermutedToBGRA() {
    let converter = NDIVideoFrameConverter()
    let (frame, buffer) = makeFrame(fourCC: NDIlib_FourCC_video_type_RGBA) { data, stride in
      for row in 0 ..< self.height {
        for pixel in 0 ..< self.width {
          let base = row * stride + pixel * 4
          data[base] = 0x10      // R
          data[base + 1] = 0x20  // G
          data[base + 2] = 0x30  // B
          data[base + 3] = 0xFF  // A
        }
      }
    }
    defer { buffer.deallocate() }

    guard let converted = converter.convert(frame) else { return XCTFail("copy failed") }
    CVPixelBufferLockBaseAddress(converted, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(converted, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(converted) else { return XCTFail("no address") }
    let pixels = base.assumingMemoryBound(to: UInt8.self)
    XCTAssertEqual(pixels[0], 0x30, "blue is not first")
    XCTAssertEqual(pixels[1], 0x20, "green moved")
    XCTAssertEqual(pixels[2], 0x10, "red is not third")
    XCTAssertEqual(pixels[3], 0xFF)
  }

  /// A converter is reused for the life of a source, and a camera may change geometry mid-take.
  func testPoolFollowsAResolutionChange() {
    let converter = NDIVideoFrameConverter()
    let (first, firstBuffer) = makeFrame(fourCC: NDIlib_FourCC_video_type_UYVY) { _, _ in }
    defer { firstBuffer.deallocate() }
    XCTAssertEqual(converter.convert(first).map(CVPixelBufferGetWidth), width)

    var second = first
    second.xres = Int32(width / 2)
    second.line_stride_in_bytes = Int32(width)
    XCTAssertEqual(converter.convert(second).map(CVPixelBufferGetWidth), width / 2)
  }
}
