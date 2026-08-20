import CoreGraphics
import CoreVideo
import Foundation
import Metal
import ProducerSources

/// Composites the program tile with the scorebug overlay into a single frame for the program
/// encoder.
///
/// The shader is compiled from source at startup rather than shipped as a `.metallib`
/// resource: it is ~40 lines, compilation costs tens of milliseconds once, and it removes a
/// build-system dependency from a package that otherwise has none.
public final class MetalCompositor: @unchecked Sendable {
  private let device: MTLDevice
  private let commandQueue: MTLCommandQueue
  private let pipelineYUV: MTLRenderPipelineState
  private let pipelineOverlay: MTLRenderPipelineState
  private let textureCache: CVMetalTextureCache
  private let outputPool: PixelBufferFactory

  /// Where the scorebug sits in the composited frame, in output pixels from the top-left. The
  /// overlay keeps its own size rather than being stretched to the frame, so a scorebug that grows
  /// grows rightwards and downwards from this corner.
  public static let overlayInset = CGPoint(x: 20, y: 20)

  private let lock = NSLock()
  private var overlayTexture: MTLTexture?
  private var overlaySize = CGSize.zero
  private var composedFrames: UInt64 = 0

  public let width: Int
  public let height: Int

  public init?(width: Int = 1920, height: Int = 1080) {
    guard
      let device = MTLCreateSystemDefaultDevice(),
      let commandQueue = device.makeCommandQueue(),
      let library = try? device.makeLibrary(source: Self.shaderSource, options: nil),
      let vertexFunction = library.makeFunction(name: "producer_vertex"),
      let rectVertexFunction = library.makeFunction(name: "producer_vertex_rect"),
      let yuvFunction = library.makeFunction(name: "producer_fragment_yuv"),
      let overlayFunction = library.makeFunction(name: "producer_fragment_overlay")
    else { return nil }

    let yuvDescriptor = MTLRenderPipelineDescriptor()
    yuvDescriptor.vertexFunction = vertexFunction
    yuvDescriptor.fragmentFunction = yuvFunction
    yuvDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm

    let overlayDescriptor = MTLRenderPipelineDescriptor()
    overlayDescriptor.vertexFunction = rectVertexFunction
    overlayDescriptor.fragmentFunction = overlayFunction
    overlayDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    overlayDescriptor.colorAttachments[0].isBlendingEnabled = true
    overlayDescriptor.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
    overlayDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
    overlayDescriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
    overlayDescriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha

    guard
      let pipelineYUV = try? device.makeRenderPipelineState(descriptor: yuvDescriptor),
      let pipelineOverlay = try? device.makeRenderPipelineState(descriptor: overlayDescriptor)
    else { return nil }

    var cache: CVMetalTextureCache?
    guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache) == kCVReturnSuccess,
          let cache else { return nil }

    guard let outputPool = PixelBufferFactory(
      width: width,
      height: height,
      pixelFormat: kCVPixelFormatType_32BGRA,
      minimumBuffers: 4
    ) else { return nil }

    self.device = device
    self.commandQueue = commandQueue
    self.pipelineYUV = pipelineYUV
    self.pipelineOverlay = pipelineOverlay
    self.textureCache = cache
    self.outputPool = outputPool
    self.width = width
    self.height = height
  }

  public var frameCount: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return composedFrames
  }

  /// Replaces the cached scorebug texture. Called only when the page actually changed, so the
  /// common case costs one texture bind and nothing else.
  ///
  /// `size` is how large the scorebug should appear in the composited frame, in output pixels. It
  /// is passed separately from the image because a snapshot comes back at the screen's scale, so
  /// the texture is typically twice the size it should be drawn at — using the texture's own
  /// dimensions would double every scorebug on a Retina device.
  public func setOverlay(_ image: CGImage?, size: CGSize) {
    guard let image, size.width >= 1, size.height >= 1 else {
      lock.lock()
      overlayTexture = nil
      overlaySize = .zero
      lock.unlock()
      return
    }

    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .bgra8Unorm,
      width: image.width,
      height: image.height,
      mipmapped: false
    )
    descriptor.usage = [ .shaderRead ]
    guard let texture = device.makeTexture(descriptor: descriptor) else { return }

    let bytesPerRow = image.width * 4
    var bytes = [UInt8](repeating: 0, count: bytesPerRow * image.height)
    guard let context = CGContext(
      data: &bytes,
      width: image.width,
      height: image.height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { return }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))

    texture.replace(
      region: MTLRegionMake2D(0, 0, image.width, image.height),
      mipmapLevel: 0,
      withBytes: bytes,
      bytesPerRow: bytesPerRow
    )

    lock.lock()
    overlayTexture = texture
    overlaySize = size
    lock.unlock()
  }

  /// Composites one NV12 program frame plus the cached overlay. Returns a BGRA buffer.
  public func compose(program: CVPixelBuffer) -> CVPixelBuffer? {
    guard
      let luma = makeTexture(from: program, plane: 0, format: .r8Unorm),
      let chroma = makeTexture(from: program, plane: 1, format: .rg8Unorm),
      let destination = outputPool.makeBuffer(),
      let target = makeTexture(from: destination, plane: 0, format: .bgra8Unorm),
      let commandBuffer = commandQueue.makeCommandBuffer()
    else { return nil }

    let passDescriptor = MTLRenderPassDescriptor()
    passDescriptor.colorAttachments[0].texture = target
    passDescriptor.colorAttachments[0].loadAction = .clear
    passDescriptor.colorAttachments[0].storeAction = .store
    passDescriptor.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)

    guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor) else {
      return nil
    }
    encoder.setRenderPipelineState(pipelineYUV)
    encoder.setFragmentTexture(luma, index: 0)
    encoder.setFragmentTexture(chroma, index: 1)
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)

    lock.lock()
    let overlay = overlayTexture
    let size = overlaySize
    lock.unlock()
    if let overlay {
      var rect = overlayRect(for: size)
      encoder.setRenderPipelineState(pipelineOverlay)
      encoder.setVertexBytes(&rect, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
      encoder.setFragmentTexture(overlay, index: 0)
      encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }
    encoder.endEncoding()

    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()

    lock.lock()
    composedFrames += 1
    lock.unlock()
    return destination
  }

  /// The overlay quad in clip space: `(minX, minY, maxX, maxY)`, with y running upwards.
  ///
  /// Clamped to the frame so an oversized scorebug is cropped at the edges rather than being
  /// stretched or silently dropped.
  private func overlayRect(for size: CGSize) -> SIMD4<Float> {
    let left = Self.overlayInset.x
    let top = Self.overlayInset.y
    let right = min(CGFloat(width), left + size.width)
    let bottom = min(CGFloat(height), top + size.height)

    let x0 = Float(2 * left / CGFloat(width) - 1)
    let x1 = Float(2 * right / CGFloat(width) - 1)
    let y0 = Float(1 - 2 * bottom / CGFloat(height))
    let y1 = Float(1 - 2 * top / CGFloat(height))
    return SIMD4<Float>(x0, y0, x1, y1)
  }

  private func makeTexture(
    from pixelBuffer: CVPixelBuffer,
    plane: Int,
    format: MTLPixelFormat
  ) -> MTLTexture? {
    let width = CVPixelBufferGetPlaneCount(pixelBuffer) > 0
      ? CVPixelBufferGetWidthOfPlane(pixelBuffer, plane)
      : CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetPlaneCount(pixelBuffer) > 0
      ? CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)
      : CVPixelBufferGetHeight(pixelBuffer)

    var textureRef: CVMetalTexture?
    let status = CVMetalTextureCacheCreateTextureFromImage(
      kCFAllocatorDefault,
      textureCache,
      pixelBuffer,
      nil,
      format,
      width,
      height,
      plane,
      &textureRef
    )
    guard status == kCVReturnSuccess, let textureRef else { return nil }
    return CVMetalTextureGetTexture(textureRef)
  }

  private static let shaderSource = """
  #include <metal_stdlib>
  using namespace metal;

  struct VertexOut {
    float4 position [[position]];
    float2 uv;
  };

  vertex VertexOut producer_vertex(uint id [[vertex_id]]) {
    const float2 positions[4] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(1, 1) };
    const float2 uvs[4] = { float2(0, 1), float2(1, 1), float2(0, 0), float2(1, 0) };
    VertexOut out;
    out.position = float4(positions[id], 0, 1);
    out.uv = uvs[id];
    return out;
  }

  // Same quad, placed at an arbitrary clip-space rectangle (minX, minY, maxX, maxY) so the
  // scorebug can sit in a corner at its own size instead of covering the frame.
  vertex VertexOut producer_vertex_rect(uint id [[vertex_id]],
                                        constant float4 &rect [[buffer(0)]]) {
    const float2 uvs[4] = { float2(0, 1), float2(1, 1), float2(0, 0), float2(1, 0) };
    const float2 corners[4] = {
      float2(rect.x, rect.y), float2(rect.z, rect.y),
      float2(rect.x, rect.w), float2(rect.z, rect.w)
    };
    VertexOut out;
    out.position = float4(corners[id], 0, 1);
    out.uv = uvs[id];
    return out;
  }

  // BT.709 video range, matching what the archive and program encoders expect.
  fragment float4 producer_fragment_yuv(VertexOut in [[stage_in]],
                                        texture2d<float> luma [[texture(0)]],
                                        texture2d<float> chroma [[texture(1)]]) {
    constexpr sampler bilinear(filter::linear, address::clamp_to_edge);
    float y = luma.sample(bilinear, in.uv).r;
    float2 cbcr = chroma.sample(bilinear, in.uv).rg;
    y = (y - 16.0 / 255.0) * (255.0 / 219.0);
    float cb = cbcr.x - 0.5;
    float cr = cbcr.y - 0.5;
    float r = y + 1.5748 * cr;
    float g = y - 0.1873 * cb - 0.4681 * cr;
    float b = y + 1.8556 * cb;
    return float4(saturate(float3(r, g, b)), 1.0);
  }

  fragment float4 producer_fragment_overlay(VertexOut in [[stage_in]],
                                            texture2d<float> overlay [[texture(0)]]) {
    constexpr sampler bilinear(filter::linear, address::clamp_to_edge);
    return overlay.sample(bilinear, in.uv);
  }
  """
}
