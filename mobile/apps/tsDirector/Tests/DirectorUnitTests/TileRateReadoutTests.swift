import DirectorCore
import DirectorPipeline
import Testing

@Suite("Tile rate readout")
struct TileRateReadoutTests {
  @Test("Whole frames and whole megabits, as the operator reads them")
  func labels() {
    var tile = TileTelemetry(index: 0)
    tile.framesPerSecond = 59.6
    // A 4 Mbps camera plus its audio and packet overhead: it used to read "1 MB".
    tile.receiveBytesPerSecond = 550_000
    #expect(tile.frameRateLabel == "60 FPS")
    #expect(tile.throughputLabel == "4 Mbps")
  }

  @Test("A tile with nothing arriving says so rather than showing a clean zero")
  func deadTile() {
    var tile = TileTelemetry(index: 0)
    tile.receiveBytesPerSecond = 6_700_000
    #expect(tile.frameRateLabel == "— FPS")
    #expect(tile.throughputLabel == "— Mbps")
  }

  @Test("An NDI tile with no share worked out shows a dash, not zero")
  func unmeasured() {
    var tile = TileTelemetry(index: 0)
    tile.framesPerSecond = 60
    #expect(tile.throughputLabel == "— Mbps")
  }

  @Test("The 32-bit interface counter wrapping reads as the bytes that arrived")
  func wrap() {
    var counter = WrappingByteCounter()
    #expect(counter.extend(UInt32.max - 999) == 0)
    #expect(counter.extend(UInt32.max) == 999)
    #expect(counter.extend(4_000) == 999 + 4_001)
  }
}
