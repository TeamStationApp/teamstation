import SwiftUI

/// Two chain links, drawn rather than taken from SF Symbols because the catalogue has a whole
/// chain but no broken one. Whole means the row has a link; broken means it could have one.
struct ChainLinkGlyph: View {
  var broken: Bool
  var color: Color

  var body: some View {
    Canvas { context, size in
      let stroke = StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round)
      let center = CGPoint(x: size.width / 2, y: size.height / 2)
      // Each link is a rounded pill on the 45° diagonal; the pair overlaps when whole and parts
      // along the diagonal when broken.
      let link = CGRect(x: -6, y: -3.2, width: 12, height: 6.4)
      let gap: CGFloat = broken ? 4.5 : 0
      for sign in [CGFloat(-1), 1] {
        var transform = CGAffineTransform(translationX: center.x, y: center.y)
          .rotated(by: -.pi / 4)
          .translatedBy(x: sign * (3.6 + gap), y: 0)
        if broken {
          // The parted ends are cut, so each half reads as a link that has been opened.
          transform = transform.rotated(by: sign * 0.35)
        }
        let path = Path(roundedRect: link, cornerRadius: 3.2).applying(transform)
        context.stroke(path, with: .color(color), style: stroke)
      }
      if broken {
        var slash = Path()
        slash.move(to: CGPoint(x: center.x - 2.2, y: center.y - 2.2))
        slash.addLine(to: CGPoint(x: center.x + 2.2, y: center.y + 2.2))
        context.stroke(slash, with: .color(color.opacity(0.6)), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
      }
    }
    .frame(width: 22, height: 22)
    .accessibilityHidden(true)
  }
}
