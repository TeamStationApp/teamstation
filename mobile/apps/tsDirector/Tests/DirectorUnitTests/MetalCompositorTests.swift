import CoreVideo
import DirectorPipeline
import DirectorSources
import Testing

@Suite("Metal compositor")
struct MetalCompositorTests {
  @Test("Reads both planes of an NV12 picture straight from its surface")
  func composesThePictureItWasGiven() throws {
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let factory = try #require(PixelBufferFactory(
      width: 320,
      height: 180,
      pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ))
    let input = try #require(factory.makeBuffer())

    // Video-range white, then black: a plane read from the wrong place, or not at all, turns
    // one of them into something else.
    fill(input, luma: 235, chroma: 128)
    let white = try centre(of: try #require(compositor.compose(program: input)))
    #expect(white.allSatisfy { $0 > 240 }, "white came out \(white)")

    fill(input, luma: 16, chroma: 128)
    let black = try centre(of: try #require(compositor.compose(program: input)))
    #expect(black.allSatisfy { $0 < 15 }, "black came out \(black)")

    // Video-range red: the chroma plane read in the right order, Cb then Cr.
    fill(input, luma: 63, cb: 102, cr: 240)
    let red = try centre(of: try #require(compositor.compose(program: input)))
    #expect(red[2] > 200 && red[1] < 60 && red[0] < 60, "red came out \(red) (BGR)")
  }

  @Test("Refuses a packed picture rather than reading it as two planes")
  func refusesAPackedPicture() throws {
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let factory = try #require(PixelBufferFactory(
      width: 320,
      height: 180,
      pixelFormat: kCVPixelFormatType_32BGRA
    ))
    #expect(compositor.compose(program: try #require(factory.makeBuffer())) == nil)
  }

  @Test("Composes from a stream of fresh surfaces, as a long session hands it")
  func composesFromFreshSurfaces() throws {
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    // A new pool every few frames: buffers the compositor has never seen before, which is what
    // the pools behind a camera hand it as they retire and replace their buffers over hours.
    for _ in 0 ..< 20 {
      let factory = try #require(PixelBufferFactory(
        width: 320,
        height: 180,
        pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      ))
      for _ in 0 ..< 5 {
        let input = try #require(factory.makeBuffer())
        fill(input, luma: 235, chroma: 128)
        let out = try centre(of: try #require(compositor.compose(program: input)))
        #expect(out.allSatisfy { $0 > 240 })
      }
    }
  }

  private func fill(_ buffer: CVPixelBuffer, luma: UInt8, chroma: UInt8) {
    fill(buffer, luma: luma, cb: chroma, cr: chroma)
  }

  /// Every luma sample `luma`, every chroma pair `cb, cr` (NV12 interleaves them, Cb first).
  private func fill(_ buffer: CVPixelBuffer, luma: UInt8, cb: UInt8, cr: UInt8) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    if let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
      memset(base, Int32(luma), CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        * CVPixelBufferGetHeightOfPlane(buffer, 0))
    }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) else { return }
    let row = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
    let bytes = base.assumingMemoryBound(to: UInt8.self)
    for y in 0 ..< CVPixelBufferGetHeightOfPlane(buffer, 1) {
      for x in 0 ..< CVPixelBufferGetWidthOfPlane(buffer, 1) {
        bytes[y * row + 2 * x] = cb
        bytes[y * row + 2 * x + 1] = cr
      }
    }
  }

  /// The blue, green and red of the middle pixel of a BGRA picture.
  private func centre(of buffer: CVPixelBuffer) throws -> [UInt8] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let base = try #require(CVPixelBufferGetBaseAddress(buffer))
    let row = CVPixelBufferGetBytesPerRow(buffer)
    let x = CVPixelBufferGetWidth(buffer) / 2
    let y = CVPixelBufferGetHeight(buffer) / 2
    let pixel = base.advanced(by: y * row + x * 4).assumingMemoryBound(to: UInt8.self)
    return [pixel[0], pixel[1], pixel[2]]
  }
}
