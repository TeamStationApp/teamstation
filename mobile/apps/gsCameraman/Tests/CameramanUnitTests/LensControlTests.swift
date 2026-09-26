import CameramanCore
import Foundation
import Testing

@Suite("Lens optics")
struct LensOpticsTests {
  /// Horizontal FOV of a 35 mm-equivalent prime: 2 atan(18/f).
  private func fieldOfView(millimetres: Double) -> Double {
    2 * atan(18 / millimetres) * 180 / .pi
  }

  @Test("A measured FOV becomes the millimetre label, not a per-model table")
  func fieldOfViewToMillimetres() {
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: fieldOfView(millimetres: 13)) == 13)
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: fieldOfView(millimetres: 24)) == 24)
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: fieldOfView(millimetres: 48)) == 48)
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: fieldOfView(millimetres: 77)) == 77)
  }

  @Test("A 2x native crop of 24 mm is 48 mm")
  func nativeCropDoublesFocalLength() {
    let wide = fieldOfView(millimetres: 24)
    let cropped = LensOptics.croppedFieldOfViewDegrees(horizontalFieldOfViewDegrees: wide, factor: 2)
    #expect(cropped != nil)
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: cropped!) == 48)
  }

  @Test("Impossible FOV values are refused rather than labelled")
  func invalidFieldOfView() {
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: 0) == nil)
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: 180) == nil)
    #expect(LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: .nan) == nil)
  }
}

@Suite("Lens selection")
struct LensSelectionTests {
  /// iPhone 15 Pro back: 13 / 24 / 48 / 77 mm plus the front. The 48 mm row is the 48 MP
  /// sensor's native 2x, not a fourth physical camera.
  private let fifteenPro = [
    CameraLens(
      id: "uw", position: .back, deviceType: CameraDeviceTypeName.ultraWide,
      uniqueDeviceID: "uw", focalLengthMM: 13, displayedZoom: 0.5, deviceZoom: 1, isSecondaryNative: false
    ),
    CameraLens(
      id: "wide", position: .back, deviceType: CameraDeviceTypeName.wideAngle,
      uniqueDeviceID: "wide", focalLengthMM: 24, displayedZoom: 1, deviceZoom: 2, isSecondaryNative: false
    ),
    CameraLens(
      id: "wide#native:2x", position: .back, deviceType: CameraDeviceTypeName.wideAngle,
      uniqueDeviceID: "wide", focalLengthMM: 48, displayedZoom: 2, deviceZoom: 4, isSecondaryNative: true
    ),
    CameraLens(
      id: "tele", position: .back, deviceType: CameraDeviceTypeName.telephoto,
      uniqueDeviceID: "tele", focalLengthMM: 77, displayedZoom: 3, deviceZoom: 6, isSecondaryNative: false
    ),
    CameraLens(
      id: "front", position: .front, deviceType: CameraDeviceTypeName.wideAngle,
      uniqueDeviceID: "front", focalLengthMM: 23, displayedZoom: 1, deviceZoom: 1, isSecondaryNative: false
    )
  ]

  /// iPhone 13 Pro: three back constituents, no 48 mm native crop.
  private let thirteenPro = [
    CameraLens(
      id: "uw", position: .back, deviceType: CameraDeviceTypeName.ultraWide,
      uniqueDeviceID: "uw", focalLengthMM: 13, displayedZoom: 0.5, deviceZoom: 1, isSecondaryNative: false
    ),
    CameraLens(
      id: "wide", position: .back, deviceType: CameraDeviceTypeName.wideAngle,
      uniqueDeviceID: "wide", focalLengthMM: 26, displayedZoom: 1, deviceZoom: 2, isSecondaryNative: false
    ),
    CameraLens(
      id: "tele", position: .back, deviceType: CameraDeviceTypeName.telephoto,
      uniqueDeviceID: "tele", focalLengthMM: 77, displayedZoom: 3, deviceZoom: 6, isSecondaryNative: false
    ),
    CameraLens(
      id: "front", position: .front, deviceType: CameraDeviceTypeName.wideAngle,
      uniqueDeviceID: "front", focalLengthMM: 23, displayedZoom: 1, deviceZoom: 1, isSecondaryNative: false
    )
  ]

  @Test("Every lens is on until the operator turns one off")
  func defaultUsesEveryLens() {
    let selection = LensSelection()
    #expect(selection.enabled(in: fifteenPro).count == 5)
    #expect(selection.preferredDeviceTypes(for: .back, in: fifteenPro).first == CameraDeviceTypeName.triple)
  }

  @Test("A 13 Pro catalog has no 48 mm row, so the same code does not invent one")
  func thirteenProHasNoNativeTwoTimes() {
    #expect(thirteenPro.contains(where: { $0.isSecondaryNative }) == false)
    #expect(thirteenPro.filter { $0.position == .back }.count == 3)
  }

  @Test("Only physical lenses are offered; the 48 mm crop is a zoom stop on the wide")
  func physicalLensesOnly() {
    #expect(LensSelection.physical(in: fifteenPro).map(\.id) == [ "uw", "wide", "tele", "front" ])
    #expect(LensSelection.crops(of: fifteenPro[1], in: fifteenPro).map(\.id) == [ "wide#native:2x" ])
  }

  @Test("Choosing only the telephoto opens that physical camera, not the triple")
  func telephotoOnly() {
    var selection = LensSelection()
    for lens in LensSelection.physical(in: fifteenPro) where lens.id != "tele" {
      selection = selection.toggling(lens, to: false, in: fifteenPro)
    }
    #expect(selection.preferredDeviceTypes(for: .back, in: fifteenPro) == [ CameraDeviceTypeName.telephoto ])
  }

  @Test("Turning the wide off takes its 2x crop with it, and turning it on brings the crop back")
  func cropFollowsItsLens() {
    let off = LensSelection().toggling(fifteenPro[1], to: false, in: fifteenPro)
    #expect(off.disabledIDs == [ "wide", "wide#native:2x" ])
    let on = off.toggling(fifteenPro[1], to: true, in: fifteenPro)
    #expect(on.disabledIDs.isEmpty)
  }

  @Test("Saved settings with only the 48 mm crop on read as the wide lens")
  func legacyCropOnly() {
    let saved = LensSelection(disabledIDs: [ "uw", "wide", "tele" ])
    let selection = saved.normalized(in: fifteenPro)
    #expect(selection.disabledIDs == [ "uw", "tele" ])
    #expect(selection.preferredDeviceTypes(for: .back, in: fifteenPro) == [ CameraDeviceTypeName.wideAngle ])
  }

  @Test("A crop turned off by itself comes back on with its lens")
  func legacyCropOff() {
    let saved = LensSelection(disabledIDs: [ "wide#native:2x" ])
    #expect(saved.normalized(in: fifteenPro).disabledIDs.isEmpty)
  }

  @Test("Wide plus telephoto prefers Dual Camera")
  func wideAndTele() {
    var selection = LensSelection()
    for lens in fifteenPro where lens.deviceType == CameraDeviceTypeName.ultraWide || lens.position == .front {
      selection = selection.toggling(lens, to: false, in: fifteenPro)
    }
    #expect(selection.preferredDeviceTypes(for: .back, in: fifteenPro).first == CameraDeviceTypeName.dual)
  }

  @Test("The last remaining lens cannot be turned off")
  func lastLensStaysOn() {
    var selection = LensSelection()
    for lens in LensSelection.physical(in: fifteenPro).dropLast() {
      selection = selection.toggling(lens, to: false, in: fifteenPro)
    }
    let last = fifteenPro[4]
    #expect(selection.canDisable(last, in: fifteenPro) == false)
    let refused = selection.toggling(last, to: false, in: fifteenPro)
    #expect(refused.disabledIDs == selection.disabledIDs)
    #expect(selection.isEnabled(last))
  }

  @Test("A position with every lens off is not a camera")
  func disabledPosition() {
    var selection = LensSelection()
    for lens in fifteenPro where lens.position == .front {
      selection = selection.toggling(lens, to: false, in: fifteenPro)
    }
    #expect(selection.hasEnabledLens(at: .front, in: fifteenPro) == false)
    #expect(selection.hasEnabledLens(at: .back, in: fifteenPro))
    #expect(selection.preferredDeviceTypes(for: .front, in: fifteenPro).isEmpty)
  }

  @Test("Titles prefer millimetres so the list matches what Blackmagic shows")
  func titles() {
    #expect(fifteenPro[0].title == "13 mm")
    #expect(fifteenPro[2].title == "48 mm")
    #expect(fifteenPro[3].title == "77 mm")
    #expect(fifteenPro[0].settingsLabel == "13 mm · Back")
    #expect(fifteenPro[0].accessibilityIdentifier == "settings-lens-back-0.5x")
    #expect(fifteenPro[2].accessibilityIdentifier == "settings-lens-back-2x")
  }
}
