import AVFoundation
import CoreMedia
import CoreVideo
import DirectorPipeline
import DirectorSources
import Testing

@Suite("Tile renderer enqueue fails")
struct TileRendererTests {
  @Test("A frame with no display layer counts noLayer")
  func noLayer() throws {
    let renderer = TileRenderer()
    let buffer = try pixelBuffer()
    #expect(!renderer.enqueue(pixelBuffer: buffer, presentationTime: .zero))
    #expect(renderer.failCounts.noLayer == 1)
    #expect(renderer.failCounts.paused == 0)
  }

  @Test("A paused renderer counts paused and does not enqueue")
  func paused() throws {
    let renderer = TileRenderer()
    renderer.attach(layer: AVSampleBufferDisplayLayer())
    renderer.setPaused(true)
    let buffer = try pixelBuffer()
    #expect(!renderer.enqueue(pixelBuffer: buffer, presentationTime: .zero))
    #expect(renderer.failCounts.paused == 1)
    #expect(renderer.failCounts.noLayer == 0)
  }

  @Test("An attached layer accepts a live frame")
  func attachedLayerEnqueues() throws {
    let renderer = TileRenderer()
    let layer = AVSampleBufferDisplayLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 64, height: 64)
    renderer.attach(layer: layer)
    let buffer = try pixelBuffer()
    #expect(renderer.enqueue(pixelBuffer: buffer, presentationTime: .zero))
    #expect(renderer.failCounts.noLayer == 0)
    #expect(renderer.failCounts.paused == 0)
    #expect(renderer.failCounts.formatDesc == 0)
    #expect(renderer.failCounts.sampleBuffer == 0)
  }

  private func pixelBuffer() throws -> CVPixelBuffer {
    let factory = try #require(
      PixelBufferFactory(width: 64, height: 64, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    return try #require(factory.makeBuffer())
  }
}
