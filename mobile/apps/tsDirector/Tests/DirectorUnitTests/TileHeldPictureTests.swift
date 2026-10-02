import DirectorPipeline
import Testing

@Suite("Tile held picture")
struct TileHeldPictureTests {
  @Test("A live tile says nothing")
  func liveIsQuiet() {
    var tile = TileTelemetry(index: 0)
    tile.framesPerSecond = 60
    tile.displayHeldLateSeconds = 0.4
    #expect(tile.heldPictureLabel == nil)
  }

  @Test("A picture held by the display cap says so, and for how long")
  func heldLate() {
    var tile = TileTelemetry(index: 0)
    tile.framesPerSecond = 60
    tile.displayHeldLateSeconds = 5.2
    #expect(tile.heldPictureLabel == "Late 5 s")
  }

  @Test("A stopped source outranks a late one, and long spells read in minutes")
  func stalledWins() {
    var tile = TileTelemetry(index: 0)
    tile.displayHeldLateSeconds = 5
    tile.stalledForSeconds = 7_980
    #expect(tile.heldPictureLabel == "No picture 133 min")
    tile.stalledForSeconds = 12
    #expect(tile.heldPictureLabel == "No picture 12 s")
  }
}
