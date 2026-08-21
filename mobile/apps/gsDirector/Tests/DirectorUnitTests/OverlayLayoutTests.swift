import CoreGraphics
import DirectorCore
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
}
