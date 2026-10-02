import CoreVideo
import DirectorNDI
import Testing

@Suite("NDI archive clock")
struct ArchiveTickerTests {
  private let tick = 1.0 / 60

  @Test("A camera sending the archive's own rate is encoded one picture per tick, nothing repeated")
  func steadyCamera() {
    var ticker = ArchiveTicker(frameRate: 60)
    for index in 0 ..< 120 {
      let now = Double(index) * tick
      let picture = ArchiveTicker.Picture(arrived: now - 0.004, sequence: UInt64(index))
      #expect(ticker.tick(at: now, newest: picture) == .encode(index: Int64(index), isRepeat: false))
    }
  }

  @Test("A 30 fps camera recorded at 60 has every picture encoded twice, evenly")
  func slowerCameraRepeats() {
    var ticker = ArchiveTicker(frameRate: 60)
    var repeats = 0
    for index in 0 ..< 60 {
      let now = Double(index) * tick
      let sequence = UInt64(index / 2)
      let picture = ArchiveTicker.Picture(arrived: Double(sequence) / 30, sequence: sequence)
      guard case let .encode(frame, isRepeat) = ticker.tick(at: now, newest: picture) else {
        Issue.record("tick \(index) encoded nothing")
        continue
      }
      #expect(frame == Int64(index))
      if isRepeat { repeats += 1 }
    }
    #expect(repeats == 30)
  }

  @Test("A stall shorter than the repeat window is filled with the last picture")
  func shortStallRepeats() {
    var ticker = ArchiveTicker(frameRate: 60)
    let last = ArchiveTicker.Picture(arrived: 0, sequence: 1)
    _ = ticker.tick(at: 0, newest: last)
    for index in 1 ... 24 {
      #expect(ticker.tick(at: Double(index) * tick, newest: last) == .encode(index: Int64(index), isRepeat: true))
    }
  }

  /// rec-411's case in the small: two seconds without a picture, then the camera again.
  @Test("An outage encodes nothing, and the camera comes back as long after as it really was")
  func outageLeavesAGapOfItsOwnLength() {
    var ticker = ArchiveTicker(frameRate: 60)
    let before = ArchiveTicker.Picture(arrived: 0, sequence: 1)
    _ = ticker.tick(at: 0, newest: before)
    var outages = 0
    for index in 1 ..< 150 {
      if ticker.tick(at: Double(index) * tick, newest: before) == .outage { outages += 1 }
    }
    // Repeats for the first half second, nothing after it.
    #expect(outages == 149 - 30)
    let after = ArchiveTicker.Picture(arrived: 2.5 - 0.002, sequence: 2)
    #expect(ticker.tick(at: 2.5, newest: after) == .encode(index: 150, isRepeat: false))
  }

  @Test("Nothing is encoded before the first picture, and a timer firing twice for one tick encodes once")
  func idleTicks() {
    var ticker = ArchiveTicker(frameRate: 60)
    #expect(ticker.tick(at: 0, newest: nil) == .idle)
    let picture = ArchiveTicker.Picture(arrived: 1, sequence: 1)
    #expect(ticker.tick(at: 1, newest: picture) == .encode(index: 0, isRepeat: false))
    #expect(ticker.tick(at: 1 + 0.001, newest: picture) == .idle)
  }

  @Test("A timer that fires late skips a tick number rather than stamping a frame early")
  func lateTimerSkipsANumber() {
    var ticker = ArchiveTicker(frameRate: 60)
    _ = ticker.tick(at: 0, newest: ArchiveTicker.Picture(arrived: 0, sequence: 0))
    let picture = ArchiveTicker.Picture(arrived: 2 * tick, sequence: 1)
    #expect(ticker.tick(at: 2 * tick, newest: picture) == .encode(index: 2, isRepeat: false))
  }
}

@Suite("NDI archive scaling")
struct ArchiveScalerTests {
  private func picture(width: Int, height: Int, luma: UInt8) throws -> CVPixelBuffer {
    var made: CVPixelBuffer?
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()]
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &made)
    let buffer = try #require(made)
    CVPixelBufferLockBaseAddress(buffer, [])
    for plane in 0 ..< 2 {
      let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane)!
      memset(base, plane == 0 ? Int32(luma) : 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane))
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  private func luma(_ buffer: CVPixelBuffer, x: Int, y: Int) -> UInt8 {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
    return base[y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) + x]
  }

  @Test("A picture already the archive's size is passed through untouched")
  func sameSizePassesThrough() throws {
    let scaler = try #require(ArchiveScaler(width: 1920, height: 1080))
    let source = try picture(width: 1920, height: 1080, luma: 200)
    #expect(scaler.scale(source) === source)
  }

  @Test("A 720p picture is scaled up to fill a 1080p archive")
  func smallerPictureFills() throws {
    let scaler = try #require(ArchiveScaler(width: 1920, height: 1080))
    let output = try #require(scaler.scale(try picture(width: 1280, height: 720, luma: 180)))
    #expect(CVPixelBufferGetWidth(output) == 1920)
    #expect(CVPixelBufferGetHeight(output) == 1080)
    #expect(abs(Int(luma(output, x: 20, y: 540)) - 180) < 8)
  }

  @Test("A 4:3 picture is fitted inside a 16:9 archive with black bars at the sides")
  func otherShapeIsLetterboxed() throws {
    let scaler = try #require(ArchiveScaler(width: 1920, height: 1080))
    let output = try #require(scaler.scale(try picture(width: 640, height: 480, luma: 200)))
    #expect(CVPixelBufferGetWidth(output) == 1920)
    #expect(luma(output, x: 20, y: 540) <= 20)
    #expect(abs(Int(luma(output, x: 960, y: 540)) - 200) < 8)
  }
}
