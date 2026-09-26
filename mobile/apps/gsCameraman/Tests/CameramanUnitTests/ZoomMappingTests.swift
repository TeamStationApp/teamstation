import CameramanCore
import Foundation
import Testing

/// The numbers here are the iPhone 13 Pro's, measured on device rather than assumed, because the
/// two zoom scales are the single easiest thing to conflate in this feature.
@Suite("Zoom mapping")
struct ZoomMappingTests {
  /// Triple camera: device zoom runs 1.0…15.0 with a 0.5 display multiplier and handovers to the
  /// wide at 2.0 and the telephoto at 6.0.
  private let triple = ZoomMapping(
    minimumDeviceZoom: 1,
    maximumDeviceZoom: 15,
    displayMultiplier: 0.5,
    switchOverDeviceZooms: [ 2, 6 ]
  )

  /// Front camera: one lens, so the two scales coincide. The recommended ceiling still becomes a
  /// tappable preset — digital, not a second lens.
  private let front = ZoomMapping(minimumDeviceZoom: 1, maximumDeviceZoom: 8)

  /// iPhone 13 Pro recommended range: device 1…18, displayed 0.5x…9x.
  private let thirteenPro = ZoomMapping(
    minimumDeviceZoom: 1,
    maximumDeviceZoom: 18,
    displayMultiplier: 0.5,
    switchOverDeviceZooms: [ 2, 6 ]
  )

  @Test("Device zoom 1.0 on a triple camera reads as 0.5x, not 1x")
  func widestReadsAsHalf() {
    #expect(triple.displayedZoom(forDevice: 1) == 0.5)
    // The number an operator calls "1x" is device zoom 2.0, the wide lens.
    #expect(triple.deviceZoom(forDisplayed: 1) == 2)
  }

  @Test("The two scales coincide when the multiplier is 1")
  func singleLensScalesMatch() {
    #expect(front.displayedZoom(forDevice: 3) == 3)
    #expect(front.deviceZoom(forDisplayed: 3) == 3)
  }

  @Test("Round-tripping a displayed zoom returns the same value")
  func roundTrip() {
    for displayed in [ 0.5, 1.0, 2.0, 3.0, 7.5 ] {
      let device = triple.deviceZoom(forDisplayed: displayed)
      #expect(abs(triple.displayedZoom(forDevice: device) - displayed) < 0.000_1)
    }
  }

  @Test("Clamping holds the device range, so zooming out past the ultra-wide is impossible")
  func clamping() {
    #expect(triple.clampDeviceZoom(0.1) == 1)
    #expect(triple.clampDeviceZoom(99) == 15)
    #expect(triple.clampDeviceZoom(4) == 4)
    // 0.25x does not exist on this hardware and must come back as the widest, 0.5x.
    #expect(triple.clampDisplayedZoom(0.25) == 0.5)
    #expect(triple.clampDisplayedZoom(100) == 7.5)
  }

  @Test("A non-finite zoom cannot escape the range")
  func nonFiniteZoom() {
    #expect(triple.clampDeviceZoom(.nan) == 1)
    #expect(triple.clampDeviceZoom(.infinity) == 1)
  }

  @Test("Lens index steps at each switchover")
  func lensIndex() {
    #expect(triple.lensIndex(forDevice: 1) == 0)
    #expect(triple.lensIndex(forDevice: 1.99) == 0)
    #expect(triple.lensIndex(forDevice: 2) == 1)
    #expect(triple.lensIndex(forDevice: 5.99) == 1)
    #expect(triple.lensIndex(forDevice: 6) == 2)
    #expect(triple.lensIndex(forDevice: 15) == 2)
    // One lens means one index, whatever the digital zoom.
    #expect(front.lensIndex(forDevice: 8) == 0)
  }

  @Test("Preset pills come out of the hardware, not a hardcoded 0.5/1/2/5")
  func presets() {
    #expect(triple.presetDisplayedZooms == [ 0.5, 1, 3, 7.5 ])
    #expect(thirteenPro.presetDisplayedZooms == [ 0.5, 1, 3, 9 ])
    // One lens plus the digital ceiling — not a second optical preset.
    #expect(front.presetDisplayedZooms == [ 1, 8 ])
  }

  @Test("Pinch multiplies against the zoom at gesture start")
  func pinch() {
    #expect(triple.pinchedDeviceZoom(from: 2, scale: 2) == 4)
    #expect(triple.pinchedDeviceZoom(from: 2, scale: 0.25) == 1)
    // A pinch that would exceed the hardware stops at the limit rather than throwing.
    #expect(triple.pinchedDeviceZoom(from: 10, scale: 4) == 15)
  }

  @Test("A zero or invalid pinch scale leaves the zoom where it started")
  func degeneratePinch() {
    #expect(triple.pinchedDeviceZoom(from: 3, scale: 0) == 3)
    #expect(triple.pinchedDeviceZoom(from: 3, scale: .nan) == 3)
  }

  @Test("Unreachable switchovers are discarded")
  func unreachableSwitchovers() {
    let mapping = ZoomMapping(
      minimumDeviceZoom: 1,
      maximumDeviceZoom: 5,
      displayMultiplier: 0.5,
      switchOverDeviceZooms: [ 0.5, 1, 2, 9 ]
    )
    // 0.5 and 1 are at or below the minimum and 9 is past the maximum: a pill for any of them would
    // do nothing when tapped.
    #expect(mapping.switchOverDeviceZooms == [ 2 ])
  }

  @Test("Switchovers are sorted, so lens index cannot depend on device ordering")
  func sortedSwitchovers() {
    let mapping = ZoomMapping(
      minimumDeviceZoom: 1,
      maximumDeviceZoom: 15,
      displayMultiplier: 0.5,
      switchOverDeviceZooms: [ 6, 2 ]
    )
    #expect(mapping.switchOverDeviceZooms == [ 2, 6 ])
    #expect(mapping.lensIndex(forDevice: 3) == 1)
  }

  @Test("A degenerate multiplier falls back to 1 instead of dividing by zero")
  func degenerateMultiplier() {
    let mapping = ZoomMapping(maximumDeviceZoom: 4, displayMultiplier: 0)
    #expect(mapping.displayMultiplier == 1)
    #expect(mapping.deviceZoom(forDisplayed: 2) == 2)
  }

  @Test("A maximum below the minimum cannot invert the range")
  func invertedRange() {
    let mapping = ZoomMapping(minimumDeviceZoom: 2, maximumDeviceZoom: 1)
    #expect(mapping.maximumDeviceZoom == 2)
    #expect(mapping.clampDeviceZoom(5) == 2)
  }

  @Test("The zoom ceiling comes from the recommended range, not the available maximum")
  func recommendedCeilingWins() {
    // Measured on an iPhone 13 Pro: every video format on the triple camera recommends 1…18 while
    // the device reports 189 available. 189 is digital upscaling and would leave the useful part of
    // a pinch gesture a few millimetres wide.
    #expect(ZoomMapping.resolveMaximumDeviceZoom(recommended: 18, available: 189) == 18)
    #expect(triple.displayedZoom(forDevice: 18) == 9)
  }

  @Test("A device with no recommendation falls back rather than exposing 189x")
  func missingRecommendationFallsBack() {
    // The front camera on a 13 Pro reports no recommended range at all.
    let ceiling = ZoomMapping.resolveMaximumDeviceZoom(recommended: nil, available: 189)
    #expect(ceiling == ZoomMapping.singleLensZoomFallback)
    #expect(ceiling == 5)
  }

  @Test("A recommendation above what the device offers cannot exceed the hardware")
  func recommendationIsStillClamped() {
    #expect(ZoomMapping.resolveMaximumDeviceZoom(recommended: 30, available: 12) == 12)
  }

  @Test("A degenerate recommendation of 1 is treated as absent")
  func degenerateRecommendation() {
    // A ceiling equal to the floor would leave no zoom range at all.
    #expect(ZoomMapping.resolveMaximumDeviceZoom(recommended: 1, available: 189) == 5)
  }

  @Test("Labels read the way the Camera app writes them")
  func labels() {
    #expect(ZoomMapping.label(forDisplayed: 0.5) == "0.5x")
    #expect(ZoomMapping.label(forDisplayed: 1) == "1x")
    #expect(ZoomMapping.label(forDisplayed: 3.0) == "3x")
    #expect(ZoomMapping.label(forDisplayed: 2.5) == "2.5x")
  }

  @Test("An exact lens zoom lights the preset, not a neighbouring tick")
  func exactPresetLightsTheButton() {
    #expect(thirteenPro.scaleHighlight(forDisplayed: 0.5) == .preset(0.5))
    #expect(thirteenPro.scaleHighlight(forDisplayed: 1) == .preset(1))
    #expect(thirteenPro.scaleHighlight(forDisplayed: 3) == .preset(3))
    #expect(thirteenPro.scaleHighlight(forDisplayed: 9) == .preset(9))
    // The label rounds to one decimal, so 1.04 still reads 1x and should keep the 1x button lit.
    #expect(thirteenPro.scaleHighlight(forDisplayed: 1.04) == .preset(1))
  }

  @Test("A pinch between two lenses lights one of the five bars")
  func ticksBetweenPresets() {
    #expect(thirteenPro.scaleSegmentCount == 3)
    // 0.5x…1x. 0.7x is well inside and rounds to 0.7x, not a preset.
    let betweenWide = thirteenPro.scaleHighlight(forDisplayed: 0.7)
    #expect(betweenWide == .tick(segment: 0, index: 2))
    let betweenTele = thirteenPro.scaleHighlight(forDisplayed: 2)
    #expect(betweenTele == .tick(segment: 1, index: 2))
    // First bar of a segment, not the left-hand preset.
    #expect(thirteenPro.scaleHighlight(forDisplayed: 0.6) == .tick(segment: 0, index: 1))
    // 3x…9x is now a real segment, not "past the last lens".
    let betweenMax = thirteenPro.scaleHighlight(forDisplayed: 6)
    #expect(betweenMax == .tick(segment: 2, index: 2))
  }

  @Test("A pinch between the telephoto and the digital ceiling lights the last segment")
  func ticksBetweenTeleAndMax() {
    #expect(thirteenPro.scaleHighlight(forDisplayed: 5) == .tick(segment: 2, index: 1))
  }

  @Test("A single-lens camera still gets a digital-max preset")
  func singleLensHasDigitalMax() {
    #expect(front.scaleSegmentCount == 1)
    #expect(front.scaleHighlight(forDisplayed: 1) == .preset(1))
    #expect(front.scaleHighlight(forDisplayed: 8) == .preset(8))
    #expect(front.scaleHighlight(forDisplayed: 3) == .tick(segment: 0, index: 1))
  }

  @Test("Scale progress is equal per pill gap, not per zoom ratio")
  func scaleProgressWalksPillsEvenly() {
    #expect(abs(thirteenPro.scaleProgress(forDisplayed: 0.5) - 0) < 0.000_1)
    #expect(abs(thirteenPro.scaleProgress(forDisplayed: 1) - 1 / 3) < 0.000_1)
    #expect(abs(thirteenPro.scaleProgress(forDisplayed: 3) - 2 / 3) < 0.000_1)
    #expect(abs(thirteenPro.scaleProgress(forDisplayed: 9) - 1) < 0.000_1)
    #expect(abs(thirteenPro.displayedZoom(forScaleProgress: 0) - 0.5) < 0.000_1)
    #expect(abs(thirteenPro.displayedZoom(forScaleProgress: 1 / 3) - 1) < 0.000_1)
    #expect(abs(thirteenPro.displayedZoom(forScaleProgress: 2 / 3) - 3) < 0.000_1)
    #expect(abs(thirteenPro.displayedZoom(forScaleProgress: 1) - 9) < 0.000_1)
  }

  @Test("A drag as long as one pill gap walks exactly one segment")
  func dragMatchesPillSpacing() {
    let gap = 80.0
    #expect(thirteenPro.displayedZoom(draggingFrom: 1, byPoints: gap, pointsPerSegment: gap) == 3)
    #expect(thirteenPro.displayedZoom(draggingFrom: 3, byPoints: gap, pointsPerSegment: gap) == 9)
    #expect(thirteenPro.displayedZoom(draggingFrom: 1, byPoints: -gap, pointsPerSegment: gap) == 0.5)
    #expect(thirteenPro.displayedZoom(draggingFrom: 1, byPoints: gap / 2, pointsPerSegment: gap) == 2)
    #expect(thirteenPro.displayedZoom(draggingFrom: 1, byPoints: 4 * gap, pointsPerSegment: gap) == 9)
  }

  /// iPhone 15 Pro: the camera stops at 9x, and Cameraman's software zoom doubles it to 18x.
  private let softwareZoom = ZoomMapping(
    minimumDeviceZoom: 1,
    maximumDeviceZoom: 36,
    displayMultiplier: 0.5,
    switchOverDeviceZooms: [ 2, 6 ],
    softwareZoomStartDeviceZoom: 18
  )

  @Test("Software zoom adds the camera's ceiling and the doubled maximum as pills")
  func softwareZoomPresets() {
    #expect(softwareZoom.presetDisplayedZooms == [ 0.5, 1, 3, 9, 18 ])
    #expect(softwareZoom.clampDisplayedZoom(100) == 18)
    #expect(softwareZoom.softwareZoomStartDisplayedZoom == 9)
  }

  @Test("Only zoom past the camera's ceiling, and only its segment, is software")
  func softwareZoomRange() {
    #expect(!softwareZoom.isSoftwareZoom(displayed: 9))
    #expect(!softwareZoom.isSoftwareZoom(displayed: 9.04))
    #expect(softwareZoom.isSoftwareZoom(displayed: 12))
    #expect(softwareZoom.isSoftwareZoom(displayed: 18))
    #expect(!softwareZoom.isSoftwareSegment(2))
    #expect(softwareZoom.isSoftwareSegment(3))
    #expect(!thirteenPro.isSoftwareZoom(displayed: 9))
    #expect(!thirteenPro.isSoftwareSegment(2))
  }

  @Test("A software start outside the range is dropped")
  func softwareZoomOutOfRange() {
    let atMaximum = ZoomMapping(maximumDeviceZoom: 8, softwareZoomStartDeviceZoom: 8)
    #expect(atMaximum.softwareZoomStartDeviceZoom == nil)
    #expect(atMaximum.presetDisplayedZooms == [ 1, 8 ])
  }
}
