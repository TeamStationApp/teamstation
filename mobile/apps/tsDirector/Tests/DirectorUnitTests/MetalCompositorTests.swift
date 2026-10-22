import CoreGraphics
import CoreVideo
import Foundation
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
    let white = try centre(of: try #require(compositor.composeAndWait(program: input)))
    #expect(white.allSatisfy { $0 > 240 }, "white came out \(white)")

    fill(input, luma: 16, chroma: 128)
    let black = try centre(of: try #require(compositor.composeAndWait(program: input)))
    #expect(black.allSatisfy { $0 < 15 }, "black came out \(black)")

    // Video-range red: the chroma plane read in the right order, Cb then Cr.
    fill(input, luma: 63, cb: 102, cr: 240)
    let red = try centre(of: try #require(compositor.composeAndWait(program: input)))
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
    #expect(compositor.composeAndWait(program: try #require(factory.makeBuffer())) == nil)
  }

  @Test("Composing does not wait for the GPU, and its completion runs once with the picture")
  func composesWithoutWaiting() throws {
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let factory = try #require(PixelBufferFactory(
      width: 320,
      height: 180,
      pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ))
    let input = try #require(factory.makeBuffer())
    fill(input, luma: 235, chroma: 128)
    let done = DispatchSemaphore(value: 0)
    let calls = Counter()
    let accepted = compositor.compose(program: input) { composed in
      calls.add(composed)
      done.signal()
    }
    #expect(accepted)
    #expect(done.wait(timeout: .now() + 5) == .success)
    // Give a second, wrong call the chance to arrive before counting.
    Thread.sleep(forTimeInterval: 0.05)
    #expect(calls.count == 1)
    let white = try centre(of: try #require(calls.last))
    #expect(white.allSatisfy { $0 > 240 }, "white came out \(white)")
    #expect(compositor.frameCount == 1)
  }

  @Test("A refused picture never calls the completion and is not counted as composed")
  func refusalNeverCompletes() throws {
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let factory = try #require(PixelBufferFactory(width: 320, height: 180, pixelFormat: kCVPixelFormatType_32BGRA))
    let calls = Counter()
    let accepted = compositor.compose(program: try #require(factory.makeBuffer())) { calls.add($0) }
    #expect(!accepted)
    Thread.sleep(forTimeInterval: 0.05)
    #expect(calls.count == 0)
    #expect(compositor.frameCount == 0)
  }

  @Test("An overlay is burned in where it was placed, and nowhere else")
  func burnsInTheOverlay() throws {
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let context = try #require(CGContext(
      data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ))
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    let red = try #require(context.makeImage())
    // The left half of the frame, so the centre column falls just outside it.
    compositor.setOverlays([ .init(image: red, origin: .zero, size: CGSize(width: 150, height: 180)) ])

    let factory = try #require(PixelBufferFactory(
      width: 320,
      height: 180,
      pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ))
    let input = try #require(factory.makeBuffer())
    fill(input, luma: 16, chroma: 128)
    let out = try #require(compositor.composeAndWait(program: input))
    let inside = pixel(of: out, x: 40, y: 90)
    let outside = pixel(of: out, x: 280, y: 90)
    #expect(inside[2] > 200 && inside[1] < 40 && inside[0] < 40, "overlay came out \(inside) (BGR)")
    #expect(outside.allSatisfy { $0 < 15 }, "picture outside the overlay came out \(outside)")
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
        let out = try centre(of: try #require(compositor.composeAndWait(program: input)))
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

  /// The blue, green and red of one pixel of a BGRA picture.
  private func pixel(of buffer: CVPixelBuffer, x: Int, y: Int) -> [UInt8] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
    let bytes = base.advanced(by: y * CVPixelBufferGetBytesPerRow(buffer) + x * 4).assumingMemoryBound(to: UInt8.self)
    return [bytes[0], bytes[1], bytes[2]]
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

/// Counts completions, from whichever thread Metal calls them on.
private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var buffers: [CVPixelBuffer?] = []

  func add(_ buffer: CVPixelBuffer?) {
    lock.lock()
    buffers.append(buffer)
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return buffers.count
  }

  var last: CVPixelBuffer? {
    lock.lock()
    defer { lock.unlock() }
    return buffers.last ?? nil
  }
}
