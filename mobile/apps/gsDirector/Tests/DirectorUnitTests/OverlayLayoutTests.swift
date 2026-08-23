import CoreGraphics
import DirectorCore
import Foundation
import Testing

@Suite("Overlay layout")
struct OverlayLayoutTests {
  @Test("Center-quarter keeps aspect and uses a quarter of the larger axis")
  func centerQuarter() {
    let canvas = CGSize(width: 1920, height: 1080)
    let rect = OverlayLayout.centerQuarter(native: CGSize(width: 1920, height: 1080), canvas: canvas)
    #expect(abs(rect.width - 480) < 0.5)
    #expect(abs(rect.height - 270) < 0.5)
    #expect(abs(rect.midX - 960) < 0.5)
    #expect(abs(rect.midY - 540) < 0.5)
  }

  @Test("A tall graphic is limited by canvas height")
  func tallGraphic() {
    let canvas = CGSize(width: 1920, height: 1080)
    let rect = OverlayLayout.centerQuarter(native: CGSize(width: 100, height: 1000), canvas: canvas)
    #expect(abs(rect.height - 270) < 0.5)
    #expect(abs(rect.width - 27) < 0.5)
  }

  @Test("Top-left seed parks at the inset")
  func topLeftNative() {
    let canvas = CGSize(width: 1920, height: 1080)
    let rect = OverlayLayout.topLeftNative(native: CGSize(width: 400, height: 120), canvas: canvas)
    #expect(rect.origin.x == OverlayLayout.topLeftInset.x)
    #expect(rect.origin.y == OverlayLayout.topLeftInset.y)
    #expect(rect.width == 400)
    #expect(rect.height == 120)
  }

  @Test("Web scale keeps the page's natural size instead of a layout box")
  func webScaleFromNative() {
    let canvas = CGSize(width: 1920, height: 1080)
    let first = OverlayLayout.scaledNormalized(
      native: CGSize(width: 800, height: 200),
      scale: 0.5,
      canvas: canvas
    )
    var overlay = ProgramOverlay(
      kind: .web,
      originX: 0.1,
      originY: 0.1,
      width: first.width,
      height: first.height,
      scale: 0.5,
      nativeWidth: 800,
      nativeHeight: 200,
      placement: .centerQuarter,
      hasLaidOut: true
    )
    let rect = OverlayLayout.pixelRect(overlay, canvas: canvas)
    #expect(abs(rect.width - 400) < 0.5)
    #expect(abs(rect.height - 100) < 0.5)

    let preview = CGSize(width: 960, height: 540)
    let previewRect = OverlayLayout.pixelRect(overlay, canvas: preview)
    #expect(abs(previewRect.width - 200) < 0.5)
    #expect(abs(previewRect.height - 50) < 0.5)

    overlay.nativeWidth = 1000
    overlay.nativeHeight = 400
    let grownSize = OverlayLayout.scaledNormalized(
      native: CGSize(width: 1000, height: 400),
      scale: 0.5,
      canvas: canvas
    )
    overlay.width = grownSize.width
    overlay.height = grownSize.height
    let grown = OverlayLayout.pixelRect(overlay, canvas: canvas)
    #expect(abs(grown.width - 500) < 0.5)
    #expect(abs(grown.height - 200) < 0.5)
    #expect(abs(grown.minX - rect.minX) < 0.5)
    #expect(abs(grown.minY - rect.minY) < 0.5)
  }

  @Test("Web native size prefers the CSS shrink-wrap over a 2x snapshot bitmap")
  func webNativePrefersMeasured() {
    let measured = OverlayLayout.webNativeSize(
      measured: CGSize(width: 800, height: 200),
      pixelWidth: 1600,
      pixelHeight: 400,
      imageScale: 1,
      displayScale: 2
    )
    #expect(abs(measured.width - 800) < 0.5)
    #expect(abs(measured.height - 200) < 0.5)

    let fromPixels = OverlayLayout.webNativeSize(
      measured: .zero,
      pixelWidth: 1600,
      pixelHeight: 400,
      imageScale: 1,
      displayScale: 2
    )
    #expect(abs(fromPixels.width - 800) < 0.5)
    #expect(abs(fromPixels.height - 200) < 0.5)
  }

  @Test("A page size seen once does not resize the overlay")
  func firstDisagreeingSnapshotKeepsSaved() {
    let saved = CGSize(width: 800, height: 200)
    let start = Date()
    let first = OverlayLayout.resolveWebNative(
      incoming: CGSize(width: 1200, height: 300),
      saved: saved,
      pending: nil,
      now: start
    )
    #expect(first.applyLayout == false)
    #expect(abs(first.native.width - 800) < 0.5)
    #expect(abs((first.pending?.size.width ?? 0) - 1200) < 0.5)

    let matchesSaved = OverlayLayout.resolveWebNative(
      incoming: saved,
      saved: saved,
      pending: first.pending,
      now: start.addingTimeInterval(0.12)
    )
    #expect(matchesSaved.applyLayout == true)
    #expect(abs(matchesSaved.native.width - 800) < 0.5)
    #expect(matchesSaved.pending == nil)
  }

  @Test("A snapshot at the display scale is not treated as page growth")
  func retinaBitmapKeepsSaved() {
    let saved = CGSize(width: 800, height: 200)
    let retina = OverlayLayout.resolveWebNative(
      incoming: CGSize(width: 1600, height: 400),
      saved: saved,
      pending: nil,
      now: Date()
    )
    #expect(retina.applyLayout == true)
    #expect(abs(retina.native.width - 800) < 0.5)
    #expect(retina.pending == nil)
  }

  @Test("MutationObserver firing twice on load does not resize, a settled page does")
  func onlyASettledSizeApplies() {
    let saved = CGSize(width: 800, height: 200)
    let grown = CGSize(width: 1000, height: 250)
    let start = Date()
    let firstSighting = OverlayLayout.resolveWebNative(
      incoming: grown,
      saved: saved,
      pending: nil,
      now: start
    )

    // The observer fires twice within 120ms of a load, so agreement alone must not be enough.
    let secondSighting = OverlayLayout.resolveWebNative(
      incoming: grown,
      saved: saved,
      pending: firstSighting.pending,
      now: start.addingTimeInterval(0.12)
    )
    #expect(secondSighting.applyLayout == false)
    #expect(abs(secondSighting.native.width - 800) < 0.5)
    #expect(secondSighting.pending?.firstSeen == start)

    let settled = OverlayLayout.resolveWebNative(
      incoming: grown,
      saved: saved,
      pending: secondSighting.pending,
      now: start.addingTimeInterval(OverlayLayout.webNativeSettleSeconds + 0.1)
    )
    #expect(settled.applyLayout == true)
    #expect(abs(settled.native.width - 1000) < 0.5)
    #expect(settled.pending == nil)
  }

  @Test("A saved size that is already wrong recovers without visiting the editor")
  func wrongSavedSizeRecovers() {
    let truth = CGSize(width: 800, height: 200)
    let start = Date()

    // Both directions must recover: a launch that captured the viewport saved something far too
    // wide, and a measure taken before a web font arrived saved something far too narrow.
    for wrong in [CGSize(width: 1920, height: 480), CGSize(width: 200, height: 50)] {
      let first = OverlayLayout.resolveWebNative(
        incoming: truth,
        saved: wrong,
        pending: nil,
        now: start
      )
      #expect(first.applyLayout == false)

      let settled = OverlayLayout.resolveWebNative(
        incoming: truth,
        saved: wrong,
        pending: first.pending,
        now: start.addingTimeInterval(OverlayLayout.webNativeSettleSeconds + 0.1)
      )
      #expect(settled.applyLayout == true)
      #expect(abs(settled.native.width - 800) < 0.5)
    }
  }

  @Test("A size that keeps changing never settles")
  func flappingSizeNeverApplies() {
    let saved = CGSize(width: 800, height: 200)
    let start = Date()
    var pending: OverlayLayout.PendingWebNative?
    for step in 0 ..< 6 {
      let resolved = OverlayLayout.resolveWebNative(
        incoming: CGSize(width: 1000 + CGFloat(step) * 200, height: 250),
        saved: saved,
        pending: pending,
        now: start.addingTimeInterval(Double(step))
      )
      #expect(resolved.applyLayout == false)
      #expect(abs(resolved.native.width - 800) < 0.5)
      pending = resolved.pending
    }
  }

  @Test("A first measure with no saved size applies immediately")
  func firstEverMeasureApplies() {
    let resolved = OverlayLayout.resolveWebNative(
      incoming: CGSize(width: 1920, height: 200),
      saved: .zero,
      pending: nil,
      now: Date()
    )
    #expect(resolved.applyLayout == true)
    #expect(abs(resolved.native.width - 1920) < 0.5)
  }

  @Test("Re-rendering the same graphic at another CSS scale keeps the operator's size")
  func rescaledPageKeepsDisplaySize() {
    // Measured on the M4: the NPLL scoreboard reports 405x108 on one load and 637x170 on the
    // next, same shape either way, and the box used to grow from a third of Output to a half.
    let canvas = CGSize(width: 1920, height: 1080)
    let small = CGSize(width: 405, height: 108)
    let large = CGSize(width: 637, height: 170)
    let operatorScale = 1.4963
    let wanted = OverlayLayout.scaledNormalized(
      native: small,
      scale: operatorScale,
      canvas: canvas
    )

    let grown = OverlayLayout.scalePreservingDisplay(
      scale: operatorScale,
      from: small,
      to: large
    )
    let afterGrowth = OverlayLayout.scaledNormalized(native: large, scale: grown, canvas: canvas)
    #expect(abs(afterGrowth.width - wanted.width) < 0.001)
    #expect(abs(afterGrowth.height - wanted.height) < 0.001)

    // And back again, so repeated loads do not ratchet the box in either direction.
    let restored = OverlayLayout.scalePreservingDisplay(scale: grown, from: large, to: small)
    #expect(abs(restored - operatorScale) < 0.0001)
  }

  @Test("A page that changes shape still moves the box")
  func reshapedPageResizes() {
    let canvas = CGSize(width: 1920, height: 1080)
    let before = CGSize(width: 405, height: 108)
    let taller = CGSize(width: 405, height: 216)
    #expect(
      OverlayLayout.aspectsAgree(
        Double(before.width / before.height),
        Double(taller.width / taller.height)
      ) == false
    )
    let size = OverlayLayout.scaledNormalized(native: taller, scale: 1.4963, canvas: canvas)
    #expect(size.height > Double(before.height / canvas.height))
  }

  @Test("Aspect agreement decides whether a held-back bitmap can still be drawn")
  func aspectAgreement() {
    #expect(OverlayLayout.aspectsAgree(4, 4) == true)
    #expect(OverlayLayout.aspectsAgree(4, 4.2) == true)
    #expect(OverlayLayout.aspectsAgree(4, 16.0 / 9.0) == false)
    #expect(OverlayLayout.aspectsAgree(0, 4) == false)
  }

  @Test("Web corner scale plants the origin so the box grows right and down")
  func scaledFromOrigin() {
    let start = CGRect(x: 100, y: 80, width: 400, height: 200)
    let grown = OverlayLayout.scaledFromOrigin(start, translation: CGSize(width: 200, height: 50))
    #expect(abs(grown.width - 600) < 0.5)
    #expect(abs(grown.height - 300) < 0.5)
    #expect(abs(grown.minX - 100) < 0.5)
    #expect(abs(grown.minY - 80) < 0.5)
  }

  @Test("Corner resize keeps aspect and the opposite corner planted")
  func cornerResize() {
    let canvas = CGSize(width: 1920, height: 1080)
    let start = CGRect(x: 100, y: 100, width: 400, height: 200)
    let grown = OverlayLayout.resized(
      start,
      corner: .bottomRight,
      translation: CGSize(width: 200, height: 0),
      canvas: canvas
    )
    #expect(abs(grown.width - 600) < 0.5)
    #expect(abs(grown.height - 300) < 0.5)
    #expect(abs(grown.minX - 100) < 0.5)
    #expect(abs(grown.minY - 100) < 0.5)

    let fromLeft = OverlayLayout.resized(
      start,
      corner: .topLeft,
      translation: CGSize(width: -100, height: 0),
      canvas: canvas
    )
    #expect(abs(fromLeft.width - 500) < 0.5)
    #expect(abs(fromLeft.height - 250) < 0.5)
    #expect(abs(fromLeft.maxX - start.maxX) < 0.5)
    #expect(abs(fromLeft.maxY - start.maxY) < 0.5)
  }

  @Test("Content within 20 display pixels of a web view's right or bottom edge attaches")
  func attachmentSnap() {
    let parent = CGRect(x: 40, y: 40, width: 200, height: 80)
    let toTheRight = CGRect(x: 250, y: 50, width: 60, height: 60)
    let right = OverlayLayout.attachment(parent: parent, child: toTheRight)
    #expect(right?.edge == .right)
    #expect(abs((right?.gap ?? 99) - 10) < 0.5)

    let below = CGRect(x: 50, y: 130, width: 80, height: 40)
    let bottom = OverlayLayout.attachment(parent: parent, child: below)
    #expect(bottom?.edge == .bottom)
    #expect(abs((bottom?.gap ?? 99) - 10) < 0.5)

    let far = CGRect(x: 300, y: 50, width: 60, height: 60)
    #expect(OverlayLayout.attachment(parent: parent, child: far) == nil)
  }

  @Test("Attached content is pushed right or down when the web view grows")
  func anchoredPush() {
    let parent = CGRect(x: 40, y: 40, width: 200, height: 80)
    let child = CGRect(x: 250, y: 50, width: 60, height: 60)
    let grown = CGRect(x: 40, y: 40, width: 320, height: 140)
    let origin = OverlayLayout.anchoredOrigin(parent: grown, child: child, edge: .right, gap: 10)
    #expect(abs(origin.x - 370) < 0.5)
    #expect(abs(origin.y - 50) < 0.5)

    let down = OverlayLayout.anchoredOrigin(parent: grown, child: child, edge: .bottom, gap: 10)
    #expect(abs(down.x - 250) < 0.5)
    #expect(abs(down.y - 190) < 0.5)
  }

  @Test("Web list thumb is the top-left min(width, height) square")
  func webThumbnailCrop() {
    let wide = OverlayLayout.webThumbnailCrop(contentSize: CGSize(width: 1000, height: 200))
    #expect(wide == CGRect(x: 0, y: 0, width: 200, height: 200))
    let tall = OverlayLayout.webThumbnailCrop(contentSize: CGSize(width: 200, height: 600))
    #expect(tall == CGRect(x: 0, y: 0, width: 200, height: 200))
  }

  @Test("Live-only overlays collapse off live so attached children move")
  func rewindCollapse() {
    #expect(!OverlayVisibility.shouldCollapse(showInRewind: false, programIsOffLive: false))
    #expect(OverlayVisibility.shouldCollapse(showInRewind: false, programIsOffLive: true))
    #expect(!OverlayVisibility.shouldCollapse(showInRewind: true, programIsOffLive: false))
    #expect(!OverlayVisibility.shouldCollapse(showInRewind: true, programIsOffLive: true))

    let canvas = CGSize(width: 1000, height: 1000)
    let parentID = UUID()
    let childID = UUID()
    let grandchildID = UUID()
    let parent = ProgramOverlay(
      id: parentID,
      kind: .web,
      originX: 0.1,
      originY: 0.1,
      width: 0.2,
      height: 0.2,
      placement: .centerQuarter,
      hasLaidOut: true
    )
    let child = ProgramOverlay(
      id: childID,
      kind: .image,
      originX: 0.31,
      originY: 0.12,
      width: 0.05,
      height: 0.05,
      anchorID: parentID,
      anchorEdge: .right,
      anchorGap: 10,
      placement: .centerQuarter,
      hasLaidOut: true,
      showInRewind: true
    )
    let grandchild = ProgramOverlay(
      id: grandchildID,
      kind: .image,
      originX: 0.37,
      originY: 0.12,
      width: 0.04,
      height: 0.04,
      anchorID: childID,
      anchorEdge: .right,
      anchorGap: 10,
      placement: .centerQuarter,
      hasLaidOut: true,
      showInRewind: true
    )
    let live = OverlayLayout.displayRects(
      overlays: [parent, child, grandchild],
      canvas: canvas,
      programIsOffLive: false
    )
    #expect(abs((live[parentID]?.width ?? 0) - 200) < 0.5)
    #expect(abs((live[childID]?.minX ?? 0) - 310) < 0.5)

    let rewind = OverlayLayout.displayRects(
      overlays: [parent, child, grandchild],
      canvas: canvas,
      programIsOffLive: true
    )
    #expect(rewind[parentID]?.width == 0)
    #expect(rewind[parentID]?.height == 0)
    #expect(abs((rewind[parentID]?.minX ?? 0) - 100) < 0.5)
    #expect(abs((rewind[childID]?.minX ?? 0) - 110) < 0.5)
    #expect(abs((rewind[childID]?.width ?? 0) - 50) < 0.5)
    #expect(abs((rewind[grandchildID]?.minX ?? 0) - 170) < 0.5)
  }

  @Test("Missing showInRewind decodes as live-only")
  func showInRewindDefault() throws {
    let overlay = ProgramOverlay(
      kind: .web,
      originX: 0,
      originY: 0,
      width: 0.2,
      height: 0.2,
      placement: .centerQuarter
    )
    var object = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(overlay)
    ) as? [String: Any]
    object?["showInRewind"] = nil
    let data = try JSONSerialization.data(withJSONObject: object ?? [:])
    let decoded = try JSONDecoder().decode(ProgramOverlay.self, from: data)
    #expect(decoded.showInRewind == false)
  }
}
