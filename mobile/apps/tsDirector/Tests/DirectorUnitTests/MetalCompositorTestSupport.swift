import CoreVideo
import DirectorPipeline
import Foundation

/// Where an asynchronous compose leaves its picture for the test waiting on it.
private final class ComposeResult: @unchecked Sendable {
  var buffer: CVPixelBuffer?
  var calls = 0
}

extension MetalCompositor {
  /// Composes and waits for the GPU, for tests: nil when the compositor refused the picture or the
  /// GPU failed it. The app never waits; see `ProgrammeComposer`.
  func composeAndWait(program: CVPixelBuffer, timeout: TimeInterval = 5) -> CVPixelBuffer? {
    let done = DispatchSemaphore(value: 0)
    let result = ComposeResult()
    let accepted = compose(program: program) { composed in
      result.buffer = composed
      result.calls += 1
      done.signal()
    }
    guard accepted, done.wait(timeout: .now() + timeout) == .success else { return nil }
    return result.buffer
  }
}

/// Every luma sample `luma`, every chroma pair `cb, cr` of an NV12 picture (Cb first).
func fillNV12(_ buffer: CVPixelBuffer, luma: UInt8, cb: UInt8, cr: UInt8) {
  CVPixelBufferLockBaseAddress(buffer, [])
  defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
  if let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
    memset(base, Int32(luma), CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) * CVPixelBufferGetHeightOfPlane(buffer, 0))
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
func centreBGR(of buffer: CVPixelBuffer) -> [UInt8] {
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
  let row = CVPixelBufferGetBytesPerRow(buffer)
  let pixel = base.advanced(by: CVPixelBufferGetHeight(buffer) / 2 * row + CVPixelBufferGetWidth(buffer) / 2 * 4)
    .assumingMemoryBound(to: UInt8.self)
  return [pixel[0], pixel[1], pixel[2]]
}
