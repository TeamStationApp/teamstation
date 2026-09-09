import SwiftUI

/// The mark in a linked phone's preview slot: a line down from the row above and across to the
/// name, the way an outline shows a child. It replaces the preview because there is nothing to
/// preview — the phone's picture arrives on the row above.
struct LinkIndentMark: View {
  var body: some View {
    GeometryReader { proxy in
      Path { path in
        let x = proxy.size.width * 0.28
        let y = proxy.size.height * 0.6
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: y))
        path.addLine(to: CGPoint(x: proxy.size.width * 0.75, y: y))
      }
      .stroke(
        Color.white.opacity(0.35),
        style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
      )
    }
    .accessibilityHidden(true)
  }
}
