import CoreGraphics
import CoreText
import DirectorCore
import UIKit

enum TextOverlayRenderer {
  static let horizontalPadding: CGFloat = 12
  static let verticalPadding: CGFloat = 6

  static func font(for overlay: ProgramOverlay, displayScale: CGFloat = 1) -> UIFont {
    let size = CGFloat(min(max(overlay.fontSize, 6), 200)) * max(displayScale, 0.01)
    let base: UIFont
    if overlay.fontName.isEmpty {
      base = UIFont.systemFont(ofSize: size)
    } else if let named = UIFont(name: overlay.fontName, size: size) {
      base = named
    } else {
      base = UIFont.systemFont(ofSize: size)
    }
    var traits: UIFontDescriptor.SymbolicTraits = []
    if overlay.isBold { traits.insert(.traitBold) }
    if overlay.isItalic { traits.insert(.traitItalic) }
    guard !traits.isEmpty, let descriptor = base.fontDescriptor.withSymbolicTraits(traits) else {
      return base
    }
    return UIFont(descriptor: descriptor, size: size)
  }

  static func measure(overlay: ProgramOverlay, canvas: CGSize) -> CGSize {
    _ = canvas
    let font = font(for: overlay)
    let sample = overlay.text.isEmpty ? " " : overlay.text
    let attributes = stringAttributes(overlay: overlay, font: font)
    let size = (sample as NSString).size(withAttributes: attributes)
    let shadowExtra: CGFloat = overlay.dropShadowEnabled ? 6 : 0
    return CGSize(
      width: ceil(size.width) + horizontalPadding * 2 + shadowExtra,
      height: ceil(font.lineHeight) + verticalPadding * 2 + shadowExtra
    )
  }

  static func makeImage(overlay: ProgramOverlay, canvas: CGSize) -> CGImage? {
    let pixel = OverlayLayout.pixelRect(overlay, canvas: canvas)
    let size = CGSize(width: max(pixel.width, 1), height: max(pixel.height, 1))
    let format = UIGraphicsImageRendererFormat.default()
    format.opaque = false
    format.scale = 1
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    let image = renderer.image { ctx in
      UIColor.clear.setFill()
      ctx.fill(CGRect(origin: .zero, size: size))
      let font = font(for: overlay)
      let attributes = stringAttributes(overlay: overlay, font: font)
      let sample = overlay.text as NSString
      let textSize = sample.size(withAttributes: attributes)
      let origin = glyphOrigin(textSize: textSize, in: size, align: overlay.textAlign)
      sample.draw(at: origin, withAttributes: attributes)
    }
    return image.cgImage
  }

  /// Same origin `makeImage` uses, so a UITextField caret can sit on the composited glyphs.
  static func glyphOrigin(textSize: CGSize, in bounds: CGSize, align: TextOverlayAlign) -> CGPoint {
    let x: CGFloat
    switch align {
    case .left:
      x = horizontalPadding
    case .center:
      x = (bounds.width - textSize.width) / 2
    case .right:
      x = bounds.width - textSize.width - horizontalPadding
    }
    let y = (bounds.height - textSize.height) / 2
    return CGPoint(x: x, y: y)
  }

  static func caretRect(
    text: String,
    font: UIFont,
    align: TextOverlayAlign,
    in bounds: CGSize,
    utf16Offset: Int
  ) -> CGRect {
    let attributes: [NSAttributedString.Key: Any] = [.font: font]
    let ns = text as NSString
    let sample = ns.length == 0 ? " " : text
    let textSize = (sample as NSString).size(withAttributes: attributes)
    let origin = glyphOrigin(textSize: textSize, in: bounds, align: align)
    let line = CTLineCreateWithAttributedString(
      NSAttributedString(string: text, attributes: attributes)
    )
    let clamped = min(max(utf16Offset, 0), ns.length)
    let xOff = CGFloat(CTLineGetOffsetForStringIndex(line, clamped, nil))
    let height = max(font.ascender - font.descender, 1)
    return CGRect(
      x: origin.x + xOff,
      y: origin.y,
      width: 2,
      height: height
    )
  }

  private static func stringAttributes(
    overlay: ProgramOverlay,
    font: UIFont
  ) -> [NSAttributedString.Key: Any] {
    let color = uiColor(overlay.textColorHex) ?? .white
    var attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: color
    ]
    if overlay.dropShadowEnabled {
      let shadow = NSShadow()
      shadow.shadowColor = uiColor(overlay.dropShadowColorHex) ?? .black
      shadow.shadowOffset = CGSize(width: 0, height: 2)
      shadow.shadowBlurRadius = 4
      attributes[.shadow] = shadow
    }
    return attributes
  }

  static func uiColor(_ hex: String) -> UIColor? {
    guard let rgb = OverlayColorHex.parse(hex) else { return nil }
    return UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
  }
}
