import DirectorPipeline
import DirectorUI
import Testing

/// Each part of the caption becomes known at a different moment, so the interesting cases are the
/// partial ones: a camera that has just been switched on knows its codec and nothing else.
@Suite("Source format label")
struct SourceFormatLabelTests {
  @Test("Codec, size and rate read as one line")
  func fullLabel() {
    #expect(
      SourceFormatLabel.text(codec: "HEVC", width: 1920, height: 1080, framesPerSecond: 30)
        == "HEVC · 1920×1080 · 30 fps"
    )
  }

  @Test("Only the codec is known between switching on and the first decoded picture")
  func codecOnly() {
    #expect(
      SourceFormatLabel.text(codec: "H.264", width: 0, height: 0, framesPerSecond: 0) == "H.264"
    )
  }

  @Test("A size with no measured rate yet omits the rate rather than showing zero")
  func sizeWithoutRate() {
    #expect(
      SourceFormatLabel.text(codec: "HEVC", width: 1280, height: 720, framesPerSecond: 0)
        == "HEVC · 1280×720"
    )
  }

  @Test("Nothing known yet leaves the row alone")
  func nothingKnown() {
    #expect(SourceFormatLabel.text(codec: "", width: 0, height: 0, framesPerSecond: 0) == nil)
  }

  @Test("A wandering measured rate is rounded so the caption does not flicker")
  func rateIsRounded() {
    #expect(
      SourceFormatLabel.text(codec: "HEVC", width: 1920, height: 1080, framesPerSecond: 29.94)
        == "HEVC · 1920×1080 · 30 fps"
    )
    #expect(
      SourceFormatLabel.text(codec: "HEVC", width: 1920, height: 1080, framesPerSecond: 30.4)
        == "HEVC · 1920×1080 · 30 fps"
    )
    #expect(
      SourceFormatLabel.text(codec: "HEVC", width: 1920, height: 1080, framesPerSecond: 59.6)
        == "HEVC · 1920×1080 · 60 fps"
    )
  }

  @Test("A half-open size is not shown as a dimension")
  func partialSizeIsOmitted() {
    #expect(
      SourceFormatLabel.text(codec: "HEVC", width: 1920, height: 0, framesPerSecond: 30)
        == "HEVC · 30 fps"
    )
  }

  @Test("The label is built from the tile the operator's row is bound to")
  func readsFromTelemetry() {
    var tile = TileTelemetry(index: 2)
    tile.sourceCodec = "HEVC"
    tile.sourceWidth = 3840
    tile.sourceHeight = 2160
    tile.framesPerSecond = 29.97

    #expect(SourceFormatLabel.text(for: tile) == "HEVC · 3840×2160 · 30 fps")
  }

  @Test("A tile with nothing reported yet has no caption")
  func emptyTelemetry() {
    #expect(SourceFormatLabel.text(for: TileTelemetry(index: 0)) == nil)
  }
}
