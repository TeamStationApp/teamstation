import DirectorCore
import Testing

@Suite("Identifiers")
struct IdentifierTests {
  @Test("TileIndex rejects positions outside the five source tiles")
  func tileIndexBounds() {
    #expect(TileIndex(0)?.displayNumber == 1)
    #expect(TileIndex(4)?.displayNumber == 5)
    #expect(TileIndex(5) == nil)
    #expect(TileIndex(-1) == nil)
    #expect(TileIndex.all.count == 5)
  }

  @Test("SourceID slugs are safe as path components")
  func sourceIDSlug() {
    #expect(SourceID("STUDIO-MAC (Cam 1)").slug == "STUDIO-MAC__Cam_1_")
    #expect(SourceID("a/b").slug == "a_b")
  }

  @Test("WallClock arithmetic is symmetric")
  func wallClockArithmetic() {
    let start = WallClock(seconds: 1000)
    #expect((start + 30).seconds == 1030)
    #expect((start - 30).seconds == 970)
    #expect(WallClock(seconds: 1030) - start == 30)
  }
}
