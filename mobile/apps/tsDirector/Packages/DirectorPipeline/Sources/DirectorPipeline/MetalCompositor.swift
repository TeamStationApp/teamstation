import CoreGraphics
import CoreVideo
import Foundation
import Metal
import DirectorCore
import DirectorSources
import UIKit

/// Composites the program tile with overlays into a single frame for the program
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
  private let outputPool: PixelBufferFactory

  /// Default parking spot for a native-size overlay.
  public static let overlayInset = OverlayLayout.topLeftInset

  private struct PlacedTexture {
    var texture: MTLTexture
    var origin: CGPoint
    var size: CGSize
  }

  private let lock = NSLock()
  private var overlayTextures: [PlacedTexture] = []
  private var composedFrames: UInt64 = 0

  public let width: Int
  public let height: Int

  /// How many composed pictures may be alive at once. Each waits in the programme's queue from when
  /// it arrives until its capture time plus D (`ProgrammePictureQueue`), up to D plus a quarter second
  /// of a 60 fps camera's pictures at D's ceiling of 2 s, and a few more are on screen or in an
  /// encoder. The pool allocates only what is asked of it, so this is a ceiling, not a cost: at 32,
  /// D at 1 s ran it dry and every picture composed past it went out without its overlay.
  public static let maximumComposedPictures = Int(((2.0 + 0.25) * 60).rounded(.up)) + 8

  public init?(width: Int = 1920, height: Int = 1080, maximumBuffers: Int = MetalCompositor.maximumComposedPictures) {
    guard
      let device = MTLCreateSystemDefaultDevice(),
      let commandQueue = device.makeCommandQueue(),
      let library = try? device.makeLibrary(source: Self.shaderSource, options: nil),
      let vertexFunction = library.makeFunction(name: "director_vertex"),
      let rectVertexFunction = library.makeFunction(name: "director_vertex_rect"),
      let yuvFunction = library.makeFunction(name: "director_fragment_yuv"),
      let overlayFunction = library.makeFunction(name: "director_fragment_overlay")
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
    overlayDescriptor.colorAttachments[0].sourceRGBBlendFactor = .one
    overlayDescriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
    overlayDescriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
    overlayDescriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha

    guard
      let pipelineYUV = try? device.makeRenderPipelineState(descriptor: yuvDescriptor),
      let pipelineOverlay = try? device.makeRenderPipelineState(descriptor: overlayDescriptor)
    else { return nil }

    guard let outputPool = PixelBufferFactory(
      width: width,
      height: height,
      pixelFormat: kCVPixelFormatType_32BGRA,
      minimumBuffers: 4,
      maximumBuffers: maximumBuffers
    ) else { return nil }

    self.device = device
    self.commandQueue = commandQueue
    self.pipelineYUV = pipelineYUV
    self.pipelineOverlay = pipelineOverlay
    self.outputPool = outputPool
    self.width = width
    self.height = height
  }

  public var frameCount: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return composedFrames
  }

  public struct OverlayItem {
    public var image: CGImage
    public var origin: CGPoint
    public var size: CGSize

    public init(image: CGImage, origin: CGPoint, size: CGSize) {
      self.image = image
      self.origin = origin
      self.size = size
    }
  }

  /// Replaces every burned-in graphic. Called when overlay content or layout changes, not per frame.
  public func setOverlays(_ items: [OverlayItem]) {
    let placed: [PlacedTexture] = items.compactMap { item in
      guard item.size.width >= 1, item.size.height >= 1 else { return nil }
      guard let texture = Self.makeTexture(device: device, image: item.image) else { return nil }
      return PlacedTexture(texture: texture, origin: item.origin, size: item.size)
    }
    lock.lock()
    overlayTextures = placed
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
    let overlays = overlayTextures
    lock.unlock()
    encoder.setRenderPipelineState(pipelineOverlay)
    for overlay in overlays {
      var rect = overlayRect(origin: overlay.origin, size: overlay.size)
      encoder.setVertexBytes(&rect, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
      encoder.setFragmentTexture(overlay.texture, index: 0)
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
  /// Clamped to the frame so an oversized graphic is cropped at the edges rather than being
  /// stretched or silently dropped.
  private func overlayRect(origin: CGPoint, size: CGSize) -> SIMD4<Float> {
    let left = origin.x
    let top = origin.y
    let right = min(CGFloat(width), left + size.width)
    let bottom = min(CGFloat(height), top + size.height)

    let x0 = Float(2 * left / CGFloat(width) - 1)
    let x1 = Float(2 * right / CGFloat(width) - 1)
    let y0 = Float(1 - 2 * bottom / CGFloat(height))
    let y1 = Float(1 - 2 * top / CGFloat(height))
    return SIMD4<Float>(x0, y0, x1, y1)
  }

  private static func makeTexture(device: MTLDevice, image: CGImage) -> MTLTexture? {
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .bgra8Unorm,
      width: image.width,
      height: image.height,
      mipmapped: false
    )
    descriptor.usage = [ .shaderRead ]
    guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }

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
    ) else { return nil }
    context.clear(CGRect(x: 0, y: 0, width: image.width, height: image.height))
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))

    texture.replace(
      region: MTLRegionMake2D(0, 0, image.width, image.height),
      mipmapLevel: 0,
      withBytes: bytes,
      bytesPerRow: bytesPerRow
    )
    return texture
  }

  /// A Metal view of one plane of a pixel buffer, made straight from its IOSurface.
  ///
  /// Not through a `CVMetalTextureCache`. Asking the cache got slower the longer the app ran, its
  /// own bookkeeping (`freeUnusedIOSurfaceTextureBackings`) on every request: measured on the iPad
  /// with one 1080p60 camera, the three textures of a programme frame took about 15 ms after 40
  /// minutes, the camera's drain thread — which composes the programme too — was busy 84% of the
  /// time, and the tile fell from 60 frames a second to 46 within the hour and to 19 after two and
  /// a half, the rest dropped where nothing counted them. A texture made from the surface directly
  /// keeps nothing between frames. The pools behind these buffers ask for IOSurface backing, so
  /// every buffer has one.
  private func makeTexture(
    from pixelBuffer: CVPixelBuffer,
    plane: Int,
    format: MTLPixelFormat
  ) -> MTLTexture? {
    guard let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue() else {
      return nil
    }
    let planar = CVPixelBufferGetPlaneCount(pixelBuffer) > 0
    let width = planar
      ? CVPixelBufferGetWidthOfPlane(pixelBuffer, plane)
      : CVPixelBufferGetWidth(pixelBuffer)
    let height = planar
      ? CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)
      : CVPixelBufferGetHeight(pixelBuffer)
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: format,
      width: width,
      height: height,
      mipmapped: false
    )
    descriptor.usage = [.shaderRead, .renderTarget]
    descriptor.storageMode = .shared
    return device.makeTexture(descriptor: descriptor, iosurface: surface, plane: planar ? plane : 0)
  }

  private static let shaderSource = """
  #include <metal_stdlib>
  using namespace metal;

  struct VertexOut {
    float4 position [[position]];
    float2 uv;
  };

  vertex VertexOut director_vertex(uint id [[vertex_id]]) {
    const float2 positions[4] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(1, 1) };
    const float2 uvs[4] = { float2(0, 1), float2(1, 1), float2(0, 0), float2(1, 0) };
    VertexOut out;
    out.position = float4(positions[id], 0, 1);
    out.uv = uvs[id];
    return out;
  }

  // Same quad, placed at an arbitrary clip-space rectangle (minX, minY, maxX, maxY) so the
  // overlay can sit in a corner at its own size instead of covering the frame.
  vertex VertexOut director_vertex_rect(uint id [[vertex_id]],
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
  fragment float4 director_fragment_yuv(VertexOut in [[stage_in]],
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

  fragment float4 director_fragment_overlay(VertexOut in [[stage_in]],
                                            texture2d<float> overlay [[texture(0)]]) {
    constexpr sampler bilinear(filter::linear, address::clamp_to_edge);
    return overlay.sample(bilinear, in.uv);
  }
  """
}
