import CoreGraphics
import CoreText
import Foundation

/// The picture a fake NDI camera sends.
///
/// Deliberately the same content as `SyntheticFrameSource.render` in the app: a sweeping bar over
/// a gradient, a stopwatch, a frame counter, and the `FrameMarker` strip. The point of the overlap
/// is diagnostic — when an NDI archive comes back wrong, the same picture arriving correctly from
/// a simulated camera says the fault is in the NDI path rather than in the content, the encoder or
/// the writer.
///
/// The stopwatch is the instrument. Frame rate tells you nothing about a stutter, but one frame
/// late anywhere in the pipeline is legible on a single still, which is how the RTSP work found
/// every timing bug it found.
final class TestPattern {
  let width: Int
  let height: Int
  let frameRate: Double
  let name: String
  let paletteIndex: Int

  /// BGRX, because CoreGraphics draws into it directly and the NDI SDK converts on send. UYVY
  /// would avoid the SDK's conversion, but building text and a gradient into 4:2:2 by hand would
  /// put the generator's own correctness in doubt every time a test failed.
  ///
  /// Two of everything, because frames are submitted to NDI asynchronously: the SDK reads the
  /// buffer it was handed until the *next* async submission returns, so drawing the next frame
  /// into the same memory would tear the one being encoded. Alternating is what makes async safe,
  /// and async is what moves the colour conversion and the SpeedHQ encode off the pacing thread.
  private let contexts: [CGContext]
  private let buffers: [UnsafeMutableRawPointer]
  private let bytesPerRow: Int
  private var index = 0

  /// The buffer holding the frame most recently drawn.
  var pixels: UnsafeMutableRawPointer { buffers[index] }

  private static let palettes: [(red: Double, green: Double, blue: Double)] = [
    (0.85, 0.25, 0.30),
    (0.20, 0.60, 0.90),
    (0.25, 0.80, 0.45),
    (0.95, 0.70, 0.20)
  ]

  init?(width: Int, height: Int, frameRate: Double, name: String, paletteIndex: Int) {
    self.width = width
    self.height = height
    self.frameRate = frameRate
    self.name = name
    self.paletteIndex = paletteIndex
    self.bytesPerRow = width * 4

    var buffers: [UnsafeMutableRawPointer] = []
    var contexts: [CGContext] = []
    for _ in 0 ..< 2 {
      let buffer = UnsafeMutableRawPointer.allocate(
        byteCount: bytesPerRow * height,
        alignment: 64
      )
      guard let context = CGContext(
        data: buffer,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
          | CGBitmapInfo.byteOrder32Little.rawValue
      ) else {
        buffer.deallocate()
        buffers.forEach { $0.deallocate() }
        return nil
      }
      // Flip so CoreGraphics coordinates match the buffer's top-down memory layout, which is what
      // FrameMarker.read assumes when the archive is decoded back.
      context.translateBy(x: 0, y: CGFloat(height))
      context.scaleBy(x: 1, y: -1)
      buffers.append(buffer)
      contexts.append(context)
    }
    self.buffers = buffers
    self.contexts = contexts
  }

  func release() {
    buffers.forEach { $0.deallocate() }
  }

  /// Draws frame `id`. `secondsOffset` lets the stopwatch show something other than
  /// frame-count time — a stalled camera resuming has to show the wall clock it resumed at, not
  /// the time it would have reached had it never stalled.
  func render(frameID id: UInt64, seconds: Double) {
    index = (index + 1) % buffers.count
    let context = contexts[index]
    let palette = Self.palettes[paletteIndex % Self.palettes.count]

    // A horizontal gradient under everything else: a flat fill is free to encode and would make
    // any bitrate measurement taken against this meaningless.
    let bands = 64
    let bandWidth = CGFloat(width) / CGFloat(bands)
    for band in 0 ..< bands {
      let position = Double(band) / Double(bands - 1)
      // The gradient itself drifts, so a frozen tile is obvious even with the bar off screen.
      let phase = (position + Double(id) / (frameRate * 6)).truncatingRemainder(dividingBy: 1)
      let shade = 0.18 + 0.62 * phase
      context.setFillColor(
        red: palette.red * shade,
        green: palette.green * shade,
        blue: palette.blue * shade,
        alpha: 1
      )
      context.fill(CGRect(
        x: CGFloat(band) * bandWidth,
        y: 0,
        width: bandWidth + 1,
        height: CGFloat(height)
      ))
    }

    // Sweeping bar: coarse motion that survives heavy compression and is obvious in a screenshot
    // even when the text is too small to read.
    let barWidth = CGFloat(width) / 24
    let travel = CGFloat(width) + barWidth
    let barX = CGFloat((Double(id) * 14).truncatingRemainder(dividingBy: Double(travel))) - barWidth
    context.setFillColor(red: 1, green: 1, blue: 1, alpha: 0.85)
    context.fill(CGRect(x: barX, y: 0, width: barWidth, height: CGFloat(height)))

    draw(name, at: CGPoint(x: 60, y: CGFloat(height) * 0.24), size: CGFloat(height) / 12)
    draw(
      String(
        format: "%02d:%02d.%02d",
        Int(seconds) / 60,
        Int(seconds) % 60,
        Int(seconds * 100) % 100
      ),
      at: CGPoint(x: 60, y: CGFloat(height) * 0.42),
      size: CGFloat(height) / 6
    )
    draw("frame \(id)", at: CGPoint(x: 60, y: CGFloat(height) * 0.70), size: CGFloat(height) / 14)
    draw(
      "\(width)x\(height) @ \(String(format: "%g", frameRate))",
      at: CGPoint(x: 60, y: CGFloat(height) * 0.80),
      size: CGFloat(height) / 22
    )

    FrameMarker.draw(value: Int(id), in: context, width: width)
  }

  private func draw(_ string: String, at point: CGPoint, size: CGFloat) {
    let context = contexts[index]
    let font = CTFontCreateWithName("Menlo-Bold" as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String):
        CGColor(red: 1, green: 1, blue: 1, alpha: 1)
    ]
    let line = CTLineCreateWithAttributedString(
      NSAttributedString(string: string, attributes: attributes)
    )
    context.saveGState()
    context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    context.textPosition = CGPoint(x: point.x, y: point.y + size)
    CTLineDraw(line, context)
    context.restoreGState()
  }
}

/// The machine-readable frame number, drawn as a strip of black and white cells along the top.
///
/// Text is for a human looking at a still; this is for a test decoding the archive back and
/// asserting that every frame it generated appears exactly once. The cell size is chosen to
/// survive 4:2:0 subsampling and a lossy encoder: 16 pixels is far larger than any chroma or
/// transform block, so a cell cannot be smeared into its neighbour.
enum FrameMarker {
  static let cellSize = 16
  static let bitCount = 24

  static func draw(value: Int, in context: CGContext, width: Int) {
    // A leading full-white cell anchors the strip, so a reader can find it without knowing the
    // margin, and a crop that loses the left edge fails loudly rather than off by one bit.
    context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: cellSize, height: cellSize))

    for bit in 0 ..< bitCount {
      let isSet = (value >> bit) & 1 == 1
      let shade: CGFloat = isSet ? 1 : 0
      context.setFillColor(red: shade, green: shade, blue: shade, alpha: 1)
      context.fill(CGRect(
        x: cellSize * (bit + 1),
        y: 0,
        width: cellSize,
        height: cellSize
      ))
    }
  }

  /// Reads the strip back out of a BGRA buffer. Used by `--self-test` to prove the generator's
  /// own picture before any of it is blamed for a failure downstream.
  static func read(bgra: UnsafeRawPointer, bytesPerRow: Int) -> Int? {
    let row = bgra.advanced(by: (cellSize / 2) * bytesPerRow).assumingMemoryBound(to: UInt8.self)
    func luma(atCell cell: Int) -> Int {
      let x = cell * cellSize + cellSize / 2
      let base = x * 4
      return (Int(row[base]) + Int(row[base + 1]) + Int(row[base + 2])) / 3
    }
    guard luma(atCell: 0) > 200 else { return nil }

    var value = 0
    for bit in 0 ..< bitCount where luma(atCell: bit + 1) > 128 {
      value |= 1 << bit
    }
    return value
  }
}
