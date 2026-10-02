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

@Suite("Tile renderer stall diagnostics")
struct TileRendererStallTests {
  private func pixelBuffer() throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(nil, 32, 32, kCVPixelFormatType_32BGRA, nil, &buffer)
    return try #require(buffer)
  }

  @Test("A tile records when it last handed a frame to the display")
  func stampsLastEnqueue() throws {
    let renderer = TileRenderer()
    renderer.attach(layer: AVSampleBufferDisplayLayer())
    #expect(renderer.failCounts.lastEnqueueAt == 0)

    let before = Date().timeIntervalSince1970
    _ = renderer.enqueue(pixelBuffer: try pixelBuffer(), presentationTime: .zero)
    let stamp = renderer.failCounts.lastEnqueueAt

    // The stall this exists to catch shows up as arrivals climbing while this stands still, so it
    // has to be a real wall clock rather than a counter.
    #expect(stamp >= before)
    #expect(stamp <= Date().timeIntervalSince1970)
  }

  @Test("A healthy renderer reports no error")
  func healthyRendererIsQuiet() throws {
    let renderer = TileRenderer()
    renderer.attach(layer: AVSampleBufferDisplayLayer())
    _ = renderer.enqueue(pixelBuffer: try pixelBuffer(), presentationTime: .zero)
    #expect(renderer.failCounts.lastRendererError.isEmpty)
    #expect(renderer.failCounts.lastRendererFailureAt == 0)
    #expect(renderer.failCounts.rendererRebuilds == 0)
  }

  @Test("A tile with no layer never stamps an enqueue it did not make")
  func noLayerDoesNotStamp() throws {
    let renderer = TileRenderer()
    #expect(!renderer.enqueue(pixelBuffer: try pixelBuffer(), presentationTime: .zero))
    #expect(renderer.failCounts.lastEnqueueAt == 0)
  }
}
