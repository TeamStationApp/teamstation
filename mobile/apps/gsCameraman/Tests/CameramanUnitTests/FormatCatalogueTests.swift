import CameramanCore
import Foundation
import Testing

@Suite("Format catalogue")
struct FormatCatalogueTests {
  private func format(
    _ width: Int,
    _ height: Int,
    _ minRate: Double,
    _ maxRate: Double,
    multiLens: Bool = true,
    binned: Bool = false
  ) -> CaptureFormatDescriptor {
    CaptureFormatDescriptor(
      width: width,
      height: height,
      minimumFrameRate: minRate,
      maximumFrameRate: maxRate,
      supportsMultiLensSwitching: multiLens,
      isBinned: binned
    )
  }

  /// Shaped like a real iPhone list: several resolutions, a high-frame-rate variant, and a 4K60
  /// format that gives up lens switching.
  private var catalogue: FormatCatalogue {
    FormatCatalogue(formats: [
      format(1280, 720, 1, 30),
      format(1920, 1080, 1, 30),
      format(1920, 1080, 1, 60),
      format(1920, 1080, 60, 240, multiLens: false),
      format(3840, 2160, 1, 30),
      format(3840, 2160, 1, 60, multiLens: false)
    ])
  }

  @Test("An exact request selects the exact format")
  func exactSelection() {
    let selected = catalogue.selection(width: 1920, height: 1080, frameRate: 30)
    #expect(selected?.width == 1920)
    #expect(selected?.height == 1080)
    #expect(selected?.maximumFrameRate == 30)
  }

  @Test("The default is 1080p30 keeping lens switching")
  func defaultSelection() {
    let selected = catalogue.defaultSelection
    #expect(selected?.label == "1920x1080@30")
    #expect(selected?.supportsMultiLensSwitching == true)
  }

  @Test("Where two formats fit, the tighter frame-rate range wins")
  func tighterRangeWins() {
    // Both the 30 and 60 formats contain 30, but running the 60 costs power for nothing.
    let selected = catalogue.selection(width: 1920, height: 1080, frameRate: 30)
    #expect(selected?.maximumFrameRate == 30)
  }

  @Test("A request only the single-lens format can serve still selects it")
  func highFrameRateFallsToSingleLens() {
    // 240 fps exists on exactly one format here and it drops lens switching. Refusing to select it
    // would make the frame rate unreachable; selecting it silently would hide the trade-off, which
    // is why `supportsMultiLensSwitching` is surfaced separately.
    let selected = catalogue.selection(width: 1920, height: 1080, frameRate: 240)
    #expect(selected?.maximumFrameRate == 240)
    #expect(selected?.supportsMultiLensSwitching == false)
  }

  @Test("An unavailable resolution falls back to the nearest by pixel count")
  func nearestResolution() {
    let selected = catalogue.selection(width: 2560, height: 1440, frameRate: 30)
    // A 1440p request is 3.69 MP. 1080p is 1.62 MP away and 4K is 4.61 MP away, so 1080p wins —
    // dropping one step is nearer than jumping to four times the pixels.
    #expect(selected?.width == 1920)
    #expect(selected?.maximumFrameRate == 30)
  }

  @Test("An empty catalogue selects nothing rather than inventing a format")
  func emptyCatalogue() {
    #expect(FormatCatalogue(formats: []).selection(width: 1920, height: 1080, frameRate: 30) == nil)
    #expect(FormatCatalogue(formats: []).options.isEmpty)
  }

  @Test("Options collapse duplicates and keep the lens-switching answer that is true")
  func optionsMerge() {
    let options = catalogue.options
    let at1080p60 = options.filter { $0.width == 1920 && $0.frameRate == 60 }

    #expect(at1080p60.count == 1)
    // Both a switching 1080p60 and a non-switching 240 fps format cover 60, so the merged answer
    // must be the optimistic one or the UI would warn about a limitation that does not apply.
    #expect(at1080p60.first?.supportsMultiLensSwitching == true)
  }

  @Test("Options are sorted by pixel count then frame rate")
  func optionsSorted() {
    let options = catalogue.options
    for (earlier, later) in zip(options, options.dropFirst()) {
      let earlierPixels = earlier.width * earlier.height
      let laterPixels = later.width * later.height
      let ascending = earlierPixels < laterPixels
        || (earlierPixels == laterPixels && earlier.frameRate < later.frameRate)
      #expect(ascending)
    }
  }

  @Test("Only curated frame rates are offered, not every integer in the range")
  func curatedFrameRates() {
    let rates = Set(catalogue.options.map(\.frameRate))
    #expect(rates.isSubset(of: Set(FormatCatalogue.candidateFrameRates)))
    #expect(rates.contains(30))
    #expect(rates.contains(240))
  }

  @Test("A single-lens format is annotated so the trade-off is visible in the list")
  func annotation() {
    let switching = FormatCatalogue.Option(
      width: 1920, height: 1080, frameRate: 30, supportsMultiLensSwitching: true
    )
    let single = FormatCatalogue.Option(
      width: 3840, height: 2160, frameRate: 60, supportsMultiLensSwitching: false
    )
    #expect(switching.annotation == nil)
    #expect(single.annotation == "single lens only")
  }

  @Test("The maximum selection is the largest resolution at its highest rate")
  func maximumSelection() {
    let maximum = catalogue.maximumSelection
    #expect(maximum?.width == 3840)
    #expect(maximum?.maximumFrameRate == 60)
  }

  @Test("Frame-rate support is inclusive at both ends of the range")
  func frameRateBounds() {
    let descriptor = format(1920, 1080, 30, 60)
    #expect(descriptor.supports(frameRate: 30))
    #expect(descriptor.supports(frameRate: 60))
    #expect(!descriptor.supports(frameRate: 24))
    #expect(!descriptor.supports(frameRate: 120))
  }
}
