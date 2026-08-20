import CoreGraphics
import CoreMedia
import CoreText
import CoreVideo
import Foundation
import ProducerCore

/// How much per-pixel detail generated frames carry, which decides how hard they are to encode.
///
/// This distinction matters more than it looks. A flat background costs the encoder almost
/// nothing — inter-frame prediction finds the whole frame unchanged and emits a handful of skip
/// blocks — so a capacity measured on flat frames flatters the hardware and does not predict what
/// camera footage will do. Anything claiming an encode headroom figure has to use `.high`.
public enum SyntheticEntropy: String, Sendable, CaseIterable {
  /// Flat shaded fill plus overlays. A control, not a capacity test.
  case low
  /// Per-block noise reseeded every frame, so both intra prediction and motion search fail and
  /// the encoder spends real bits and real time on every frame.
  case high
}

/// Generates 1080p BGRA frames carrying a burned-in frame number, a `FrameMarker` strip and a
/// sweeping bar, plus a mono tone with a per-second click.
///
/// This is the simulator's honest analogue of what a live camera delivers (D6): decoded
/// pixels in a packed 32-bit format, arriving on someone else's thread at a fixed cadence. The
/// visible counter is the simulator's stand-in for the lab's stopwatch (D16) — if it is frozen
/// in a preview or an archive, the pipeline is broken in exactly the same way.
public final class SyntheticFrameSource: FrameSource, @unchecked Sendable {
  public let sourceID: SourceID
  public let displayName: String

  private let width: Int
  private let height: Int
  private let frameRate: Double
  private let palette: (red: Double, green: Double, blue: Double)
  private let entropy: SyntheticEntropy
  private let wireCodec: CompressedFrame.Codec
  private let clock: ProducerClock
  private let queue: DispatchQueue

  private let lock = NSLock()
  private var timer: DispatchSourceTimer?
  private var factory: PixelBufferFactory?
  private var colorSpace = CGColorSpaceCreateDeviceRGB()
  private var frameID: UInt64 = 0
  private var audioSampleIndex: Int64 = 0
  private var audioFormat: CMAudioFormatDescription?
  private var running = false
  /// Only created when something downstream wants the wire form, because encoding costs a session
  /// and the preview does not need one.
  private var videoEncoder: SyntheticWireEncoder?
  private var audioEncoder: SyntheticAudioEncoder?
  /// Frame identity across the encode, so an archived picture can still be traced to the generated
  /// one it came from. Keyed by presentation time, the only thing the encoder carries through.
  private var pendingFrameIDs: [CMTimeValue: UInt64] = [:]

  public init(
    sourceID: SourceID,
    displayName: String,
    width: Int = 1920,
    height: Int = 1080,
    frameRate: Double = 30,
    paletteIndex: Int = 0,
    entropy: SyntheticEntropy = .high,
    wireCodec: CompressedFrame.Codec = .h264,
    clock: ProducerClock = SystemClock()
  ) {
    self.sourceID = sourceID
    self.displayName = displayName
    self.width = width
    self.height = height
    self.frameRate = frameRate
    self.entropy = entropy
    self.wireCodec = wireCodec
    self.clock = clock
    self.palette = Self.palettes[paletteIndex % Self.palettes.count]
    self.queue = DispatchQueue(
      label: "co.gamestation.producer.synthetic.\(sourceID.slug)",
      qos: .userInitiated
    )
  }

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  public var format: SourceFormat? {
    SourceFormat(
      width: width,
      height: height,
      frameRate: frameRate,
      pixelFormat: kCVPixelFormatType_32BGRA
    )
  }

  public func start(sinks: FrameSinks) throws {
    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    guard let factory = PixelBufferFactory(
      width: width,
      height: height,
      pixelFormat: kCVPixelFormatType_32BGRA
    ) else {
      lock.unlock()
      throw FrameSourceError.failedToStart("could not create a \(width)x\(height) BGRA pool")
    }
    self.factory = factory
    audioFormat = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description()
    )
    if sinks.compressed != nil {
      videoEncoder = SyntheticWireEncoder(
        width: width,
        height: height,
        frameRate: frameRate,
        codec: wireCodec
      )
      videoEncoder?.setHandler { [weak self] unit in
        self?.publish(unit, to: sinks)
      }
    }
    if sinks.compressedAudio != nil {
      audioEncoder = SyntheticAudioEncoder(channelCount: 1)
    }
    running = true

    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1 / frameRate, leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in
      self?.emit(sinks: sinks)
    }
    self.timer = timer
    lock.unlock()
    timer.resume()
  }

  public func stop() {
    lock.lock()
    running = false
    let timer = self.timer
    self.timer = nil
    factory = nil
    let encoder = videoEncoder
    videoEncoder = nil
    audioEncoder = nil
    pendingFrameIDs.removeAll()
    lock.unlock()
    timer?.cancel()
    encoder?.finish()
  }

  // MARK: - Frame generation

  private func emit(sinks: FrameSinks) {
    lock.lock()
    guard running, let factory else {
      lock.unlock()
      return
    }
    let id = frameID
    frameID += 1
    let audioFormat = self.audioFormat
    let audioStart = audioSampleIndex
    let audioCount = Int(AudioSampleBuilder.sampleRate / frameRate)
    audioSampleIndex += Int64(audioCount)
    let videoEncoder = self.videoEncoder
    let audioEncoder = self.audioEncoder
    lock.unlock()

    guard let buffer = factory.makeBuffer() else { return }
    render(into: buffer, frameID: id)

    let timescale = CMTimeScale(frameRate * 1000)
    let presentationTime = CMTime(value: CMTimeValue(id) * CMTimeValue(1000), timescale: timescale)

    if let videoEncoder {
      lock.lock()
      pendingFrameIDs[presentationTime.value] = id
      lock.unlock()
      videoEncoder.encode(
        buffer,
        presentationTime: presentationTime,
        duration: CMTime(value: 1000, timescale: timescale)
      )
    }

    sinks.pixel?(PixelFrame(
      sourceID: sourceID,
      pixelBuffer: buffer,
      presentationTime: presentationTime,
      wallClock: clock.now,
      frameID: id,
      markerValue: Int(id) & FrameMarker.maximumValue
    ))

    guard sinks.audio != nil || audioEncoder != nil else { return }
    let samples = makeTone(startingAt: audioStart, count: audioCount)

    if let audioHandler = sinks.audio, let audioFormat {
      let audioTime = CMTime(
        value: CMTimeValue(audioStart),
        timescale: CMTimeScale(AudioSampleBuilder.sampleRate)
      )
      if let sampleBuffer = AudioSampleBuilder.makeSampleBuffer(
        samples: samples,
        formatDescription: audioFormat,
        presentationTime: audioTime
      ) {
        audioHandler(AudioFrame(
          sourceID: sourceID,
          sampleBuffer: sampleBuffer,
          wallClock: clock.now
        ))
      }
    }

    guard let audioEncoder, let compressedAudio = sinks.compressedAudio else { return }
    for packet in audioEncoder.encode(samples) {
      compressedAudio(CompressedAudioFrame(
        sourceID: sourceID,
        data: packet.data,
        magicCookie: audioEncoder.magicCookie,
        sampleRate: audioEncoder.sampleRate,
        channelCount: audioEncoder.channelCount,
        presentationTime: CMTime(
          value: packet.startFrame,
          timescale: CMTimeScale(audioEncoder.sampleRate)
        ),
        wallClock: clock.now
      ))
    }
  }

  private func publish(_ unit: SyntheticWireEncoder.Unit, to sinks: FrameSinks) {
    guard let handler = sinks.compressed else { return }
    lock.lock()
    let id = pendingFrameIDs.removeValue(forKey: unit.presentationTime.value)
    lock.unlock()

    handler(CompressedFrame(
      sourceID: sourceID,
      codec: wireCodec,
      data: unit.data,
      parameterSets: unit.parameterSets,
      isKeyframe: unit.isKeyframe,
      presentationTime: unit.presentationTime,
      decodeTime: .invalid,
      wallClock: clock.now,
      frameID: id ?? 0
    ))
  }

  private func render(into buffer: CVPixelBuffer, frameID id: UInt64) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }

    let bitmapInfo = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    guard let context = CGContext(
      data: base,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
      space: colorSpace,
      bitmapInfo: bitmapInfo
    ) else { return }

    // Flip so CoreGraphics coordinates match the buffer's top-down memory layout, which is
    // what FrameMarker.read assumes.
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)

    switch entropy {
    case .low:
      let phase = Double(id) / max(frameRate * 4, 1)
      let shade = 0.25 + 0.15 * (1 + sin(phase * 2 * .pi)) / 2
      context.setFillColor(
        red: palette.red * shade,
        green: palette.green * shade,
        blue: palette.blue * shade,
        alpha: 1
      )
      context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    case .high:
      fillNoise(into: buffer, base: base, frameID: id)
    }

    // Sweeping bar: a coarse motion cue that survives heavy compression and is obvious in a
    // screenshot even when the text is too small to read.
    let barWidth = CGFloat(width) / 24
    let travel = CGFloat(width) + barWidth
    let barX = CGFloat((Double(id) * 14).truncatingRemainder(dividingBy: Double(travel))) - barWidth
    context.setFillColor(red: 1, green: 1, blue: 1, alpha: 0.85)
    context.fill(CGRect(x: barX, y: 0, width: barWidth, height: CGFloat(height)))

    let seconds = Double(id) / frameRate
    drawText(
      displayName,
      at: CGPoint(x: 60, y: CGFloat(height) * 0.28),
      size: CGFloat(height) / 12,
      in: context
    )
    drawText(
      String(format: "%02d:%02d.%02d", Int(seconds) / 60, Int(seconds) % 60, Int(seconds * 100) % 100),
      at: CGPoint(x: 60, y: CGFloat(height) * 0.44),
      size: CGFloat(height) / 6,
      in: context
    )
    drawText(
      "frame \(id)",
      at: CGPoint(x: 60, y: CGFloat(height) * 0.72),
      size: CGFloat(height) / 14,
      in: context
    )

    FrameMarker.draw(value: Int(id), in: context)
  }

  /// Writes 8x8 blocks of randomly-lit palette colour straight into the buffer, reseeded each frame
  /// so nothing correlates with the previous one. 8x8 matches H.264's smallest transform, so the
  /// encoder cannot find a flat region to predict.
  ///
  /// Everything here is a bulk `memset_pattern4` or `memcpy` rather than a loop of word stores, and
  /// the difference is not marginal. A store-per-pixel version of this function ran at 1.4 fps with
  /// a core pinned: these buffers are IOSurface-backed, and individual writes to that memory are
  /// enormously slower than bulk fills. That version made the generator the bottleneck and the
  /// measurement would have been of this function rather than of the media engine.
  ///
  /// So each block row is built once — one patterned fill per block — and then replicated down the
  /// remaining seven rows with `memcpy`.
  private func fillNoise(into buffer: CVPixelBuffer, base: UnsafeMutableRawPointer, frameID: UInt64) {
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let rowBytes = min(width * 4, bytesPerRow)
    var state = ((frameID &+ 1) &* 0x9E37_79B9_7F4A_7C15) | 1
    let block = 8

    var y = 0
    while y < height {
      let rowStart = base.advanced(by: y * bytesPerRow)
      var x = 0
      while x < width {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        let shade = 0.20 + 0.80 * (Double(UInt8(truncatingIfNeeded: state)) / 255)
        // kCVPixelFormatType_32BGRA read as a native little-endian word is A<<24|R<<16|G<<8|B.
        var value = 0xFF00_0000
          | UInt32(palette.red * shade * 255) << 16
          | UInt32(palette.green * shade * 255) << 8
          | UInt32(palette.blue * shade * 255)
        let columns = min(block, width - x)
        memset_pattern4(rowStart.advanced(by: x * 4), &value, columns * 4)
        x += block
      }

      let rows = min(block, height - y)
      var row = 1
      while row < rows {
        memcpy(base.advanced(by: (y + row) * bytesPerRow), rowStart, rowBytes)
        row += 1
      }
      y += block
    }
  }

  private func drawText(_ string: String, at point: CGPoint, size: CGFloat, in context: CGContext) {
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

  private func makeTone(startingAt start: Int64, count: Int) -> [Int16] {
    let frequency = 220.0 + 110.0 * Double(abs(sourceID.rawValue.hashValue % 5))
    var samples = [Int16](repeating: 0, count: count)
    for offset in 0 ..< count {
      let index = start + Int64(offset)
      let time = Double(index) / AudioSampleBuilder.sampleRate
      var value = sin(2 * .pi * frequency * time) * 0.2
      // One click per second, so A/V sync can be measured against the visible frame counter.
      if index % Int64(AudioSampleBuilder.sampleRate) < 240 { value += 0.5 }
      samples[offset] = Int16(max(-1, min(1, value)) * Double(Int16.max))
    }
    return samples
  }

  private static let palettes: [(red: Double, green: Double, blue: Double)] = [
    (0.85, 0.25, 0.30),
    (0.20, 0.60, 0.90),
    (0.25, 0.80, 0.45),
    (0.95, 0.70, 0.20)
  ]
}
