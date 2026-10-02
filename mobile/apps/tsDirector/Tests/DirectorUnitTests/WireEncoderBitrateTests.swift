import CoreMedia
import CoreVideo
import XCTest
@testable import DirectorSources

/// Does the archive encoder actually hit the bitrate it is asked for?
///
/// This is the one question about an NDI archive that a simulator *can* answer, and the reason is
/// worth stating. A simulator has no video encode hardware, so it cannot sustain 1080p HEVC in real
/// time and an end-to-end recording there comes out decimated — which tells you nothing about rate
/// control. But rate control is a function of **presentation time**, not wall time: an encoder
/// asked for 8 Mbps and given five seconds of timestamps must produce about five megabytes however
/// long it takes to do it. So the frames are fed with a proper 30 or 60 fps timeline and the output
/// is measured against that, and the answer is the same on a simulator as on the iPad.
///
/// Content decides the answer as much as the setting does, so both ends are measured.
///
/// `.noise` is per-block random reseeded every frame: no inter-frame prediction works, no intra
/// prediction works, and 1080p of it is close to incompressible. No encoder hits 8 Mbps on it, and
/// expecting one to would be a test of physics rather than of the app. It is here as a ceiling —
/// the worst a recording can cost — not as a target.
///
/// `.picture` is a moving gradient with a sweeping bar and burned-in text: the same shape as what
/// the cameras actually send, and what a real bitrate target has to be judged against.
final class WireEncoderBitrateTests: XCTestCase {
  private let width = 1920
  private let height = 1080

  enum Content {
    /// Incompressible. A ceiling, not a target.
    case noise
    /// A moving gradient, a sweeping bar and text — camera-shaped content.
    case picture
  }

  /// Encodes `seconds` of 1080p noise at `frameRate` and returns the achieved bitrate in bits per
  /// second of *content*.
  private func achievedBitrate(
    codec: CompressedFrame.Codec,
    target: Int,
    frameRate: Double,
    seconds: Double,
    content: Content = .picture
  ) throws -> Double {
    guard let encoder = WireVideoEncoder(
      width: width,
      height: height,
      frameRate: frameRate,
      codec: codec,
      bitrate: target
    ) else {
      throw XCTSkip("no \(codec) encoder available on this machine")
    }
    guard let factory = PixelBufferFactory(
      width: width,
      height: height,
      pixelFormat: kCVPixelFormatType_32BGRA
    ) else {
      throw XCTSkip("could not create a 1080p pool")
    }

    print("  [\(codec) \(Int(frameRate))fps] data-rate ceiling status: \(encoder.dataRateLimitStatus)")

    let counted = Counter()
    encoder.setHandler { unit in counted.add(unit.data.count) }

    let frameCount = Int(frameRate * seconds)
    let timescale = CMTimeScale(600)
    let step = CMTime(
      value: CMTimeValue(600 / frameRate),
      timescale: timescale
    )

    for index in 0 ..< frameCount {
      guard let buffer = factory.makeBuffer() else { continue }
      switch content {
      case .noise: Self.fillNoise(buffer, seed: UInt64(index) &+ 1)
      case .picture: Self.fillPicture(buffer, frame: index)
      }
      encoder.encode(
        buffer,
        presentationTime: CMTimeMultiply(step, multiplier: Int32(index)),
        duration: step
      )
    }
    encoder.finish()

    // `finish` completes frames synchronously, but the callback lands on VideoToolbox's queue.
    let deadline = Date().addingTimeInterval(30)
    while counted.frames < frameCount, Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
    XCTAssertGreaterThan(counted.frames, frameCount / 2, "the encoder emitted almost nothing")

    return Double(counted.bytes) * 8 / seconds
  }

  private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var total = 0
    private var count = 0
    func add(_ bytes: Int) {
      lock.lock()
      total += bytes
      count += 1
      lock.unlock()
    }
    var bytes: Int {
      lock.lock(); defer { lock.unlock() }
      return total
    }
    var frames: Int {
      lock.lock(); defer { lock.unlock() }
      return count
    }
  }

  /// 8x8 blocks of noise, reseeded per frame, written with bulk fills. Individual writes to
  /// IOSurface-backed memory are enormously slower and would make this test the slow part.
  private static func fillNoise(_ buffer: CVPixelBuffer, seed: UInt64) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    var state = (seed &* 0x9E37_79B9_7F4A_7C15) | 1

    var y = 0
    while y < height {
      let row = base.advanced(by: y * bytesPerRow)
      var x = 0
      while x < width {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        var value = UInt32(truncatingIfNeeded: state) | 0xFF00_0000
        memset_pattern4(row.advanced(by: x * 4), &value, min(8, width - x) * 4)
        x += 8
      }
      var replicated = 1
      while replicated < min(8, height - y) {
        memcpy(base.advanced(by: (y + replicated) * bytesPerRow), row, width * 4)
        replicated += 1
      }
      y += 8
    }
  }

  /// A gradient that drifts, a sweeping bar, and a block of moving detail. Compressible the way a
  /// camera picture is compressible — inter-frame prediction works on most of the frame — without
  /// being the flat fill that would let any bitrate setting pass.
  private static func fillPicture(_ buffer: CVPixelBuffer, frame: Int) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)

    // One row built once and replicated: a horizontal gradient is constant down the frame, and a
    // per-pixel loop over 1080 rows would dominate the test's runtime.
    let row = UnsafeMutableRawPointer.allocate(byteCount: width * 4, alignment: 64)
    defer { row.deallocate() }
    let pixels = row.assumingMemoryBound(to: UInt32.self)
    let barStart = (frame * 14) % width
    for x in 0 ..< width {
      let phase = (Double(x) / Double(width) + Double(frame) / 180).truncatingRemainder(dividingBy: 1)
      var shade = UInt32(40 + 180 * phase)
      if x >= barStart, x < barStart + width / 24 { shade = 235 }
      pixels[x] = 0xFF00_0000 | (shade << 16) | (shade << 8) | shade
    }
    for y in 0 ..< height {
      memcpy(base.advanced(by: y * bytesPerRow), row, width * 4)
    }

    // A band of moving detail, so the picture is not trivially predictable everywhere.
    var state = (UInt64(frame) &+ 1) &* 0x9E37_79B9_7F4A_7C15 | 1
    for y in (height / 3) ..< (height / 3 + 120) {
      let line = base.advanced(by: y * bytesPerRow)
      var x = 0
      while x < width {
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        var value = UInt32(truncatingIfNeeded: state) | 0xFF00_0000
        memset_pattern4(line.advanced(by: x * 4), &value, min(16, width - x) * 4)
        x += 16
      }
    }
  }

  /// VideoToolbox's rate control is an *average* over a window, and a five-second clip of pure
  /// noise is the hardest case there is, so the band is deliberately generous. What it is really
  /// catching is the setting being ignored entirely — a stream that comes out at 30 Mbps or at
  /// 1 Mbps when 8 was asked for.
  private func assertNear(
    _ achieved: Double,
    target: Int,
    _ label: String,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let ratio = achieved / Double(target)
    XCTAssertTrue(
      ratio > 0.5 && ratio < 1.6,
      "\(label): asked for \(target / 1_000_000) Mbps, got \(String(format: "%.1f", achieved / 1e6)) Mbps",
      file: file,
      line: line
    )
  }

  // MARK: - HEVC, which is the default and the one that matters

  func testHEVCHits8MbpsAt30fps() throws {
    let achieved = try achievedBitrate(codec: .hevc, target: 8_000_000, frameRate: 30, seconds: 5)
    assertNear(achieved, target: 8_000_000, "HEVC 1080p30")
  }

  func testHEVCHits8MbpsAt60fps() throws {
    let achieved = try achievedBitrate(codec: .hevc, target: 8_000_000, frameRate: 60, seconds: 5)
    assertNear(achieved, target: 8_000_000, "HEVC 1080p60")
  }

  /// What a recording costs at worst. Not a pass/fail on the target — nothing compresses 1080p of
  /// random noise to 8 Mbps — but the number a disk budget has to survive, so it is measured and
  /// printed rather than left to be discovered during a game.
  func testWorstCaseContentIsRecorded() throws {
    for (codec, rate) in [
      (CompressedFrame.Codec.hevc, 30.0), (.hevc, 60.0), (.h264, 30.0), (.h264, 60.0)
    ] {
      let achieved = try achievedBitrate(
        codec: codec, target: 8_000_000, frameRate: rate, seconds: 4, content: .noise
      )
      print(String(
        format: "  worst case %@ 1080p%g asked 8 Mbps -> %.1f Mbps",
        String(describing: codec), rate, achieved / 1e6
      ))
      XCTAssertLessThan(achieved, 60_000_000, "\(codec) at \(rate) ran away entirely")
    }
  }

  /// The setting has to *do* something. Two targets an octave apart must land an octave apart, or
  /// the encoder is ignoring the number and the tests above pass by luck.
  func testHEVCBitrateSettingChangesTheOutput() throws {
    let low = try achievedBitrate(codec: .hevc, target: 4_000_000, frameRate: 30, seconds: 4)
    let high = try achievedBitrate(codec: .hevc, target: 16_000_000, frameRate: 30, seconds: 4)
    XCTAssertGreaterThan(
      high / low,
      1.8,
      "4 Mbps produced \(String(format: "%.1f", low / 1e6)) and 16 Mbps produced \(String(format: "%.1f", high / 1e6))"
    )
  }

  // MARK: - H.264

  func testH264Hits8MbpsAt30fps() throws {
    let achieved = try achievedBitrate(codec: .h264, target: 8_000_000, frameRate: 30, seconds: 5)
    assertNear(achieved, target: 8_000_000, "H.264 1080p30")
  }

  func testH264Hits8MbpsAt60fps() throws {
    let achieved = try achievedBitrate(codec: .h264, target: 8_000_000, frameRate: 60, seconds: 5)
    assertNear(achieved, target: 8_000_000, "H.264 1080p60")
  }
}
