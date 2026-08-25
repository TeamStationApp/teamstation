import CoreGraphics
import DirectorCore
import Testing
import UIKit
@testable import DirectorUI

@Suite("Text overlay caret")
struct TextOverlayCaretTests {
  @Test("End caret sits on the trailing edge of centered glyphs")
  func endCaretOnCenteredText() {
    let font = UIFont.systemFont(ofSize: 40)
    let text = "Hello Replay"
    let attributes: [NSAttributedString.Key: Any] = [.font: font]
    let textSize = (text as NSString).size(withAttributes: attributes)
    let bounds = CGSize(width: textSize.width + 24, height: textSize.height + 12)
    let caret = TextOverlayRenderer.caretRect(
      text: text,
      font: font,
      align: .center,
      in: bounds,
      utf16Offset: text.utf16.count
    )
    let origin = TextOverlayRenderer.glyphOrigin(
      textSize: textSize,
      in: bounds,
      align: .center
    )
    #expect(abs(caret.minX - (origin.x + textSize.width)) < 2)
    #expect(caret.maxX <= bounds.width + 2)
    #expect(abs(caret.height - (font.ascender - font.descender)) < 0.5)
    #expect(abs(caret.minY - origin.y) < 0.5)
    #expect(caret.maxY <= origin.y + textSize.height + 0.5)
  }

  @Test("Display scale shrinks the editor font to the fitted canvas")
  func displayScaleShrinksFont() {
    let overlay = ProgramOverlay(
      kind: .text,
      originX: 0.4,
      originY: 0.4,
      width: 0.2,
      height: 0.1,
      placement: .centerQuarter,
      text: "Hello Replay",
      fontSize: 108
    )
    let program = TextOverlayRenderer.font(for: overlay)
    let fitted = TextOverlayRenderer.font(for: overlay, displayScale: 0.5)
    #expect(abs(program.pointSize - 108) < 0.5)
    #expect(abs(fitted.pointSize - 54) < 0.5)
  }
}
