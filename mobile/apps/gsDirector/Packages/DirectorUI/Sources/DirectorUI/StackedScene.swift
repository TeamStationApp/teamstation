import SwiftUI

/// Card-stack presentation for Settings and its children: the layer underneath scales down, the
/// new layer slides up full-screen with a top grabber. Drag-to-dismiss only starts on that grabber.
enum StackedScene {
  static let behindScale: CGFloat = 0.9
  static let peek: CGFloat = 14
  static let cornerRadius: CGFloat = 16
  static let grabberHeight: CGFloat = 28
  static let dimOpacity: CGFloat = 0.32
  static let dismissDistance: CGFloat = 120
  static let dismissVelocity: CGFloat = 220
  static let animation: Animation = .spring(response: 0.38, dampingFraction: 0.86)
}

/// Bubbles up from a child stack so the parent card can hide its grabber while another layer is on top.
enum StackedSceneCoveredPreference: PreferenceKey {
  static let defaultValue = false

  static func reduce(value: inout Bool, nextValue: () -> Bool) {
    value = value || nextValue()
  }
}

extension View {
  /// Scale, round, and dim this view for each layer stacked on top of it.
  func stackedBehind(depth: Int) -> some View {
    let depth = max(0, depth)
    var scale: CGFloat = 1
    for _ in 0..<depth {
      scale *= StackedScene.behindScale
    }
    let radius: CGFloat = depth == 0 ? 0 : StackedScene.cornerRadius
    return overlay {
      Color.black.opacity(depth == 0 ? 0 : StackedScene.dimOpacity)
        .allowsHitTesting(false)
    }
    .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    .compositingGroup()
    .scaleEffect(scale, anchor: .center)
  }

  func stackedSceneCovered(_ covered: Bool) -> some View {
    preference(key: StackedSceneCoveredPreference.self, value: covered)
  }
}

/// Full-screen card that slides up over a scaled parent. Dismiss by the Done control or by dragging
/// the top grabber down; the rest of the card does not start a dismiss drag.
struct StackedSceneLayer<Content: View>: View {
  var onDismiss: () -> Void
  var covered: Bool = false
  @ViewBuilder var content: () -> Content

  @State private var dragOffset: CGFloat = 0
  @State private var childCovered = false

  private var grabberHidden: Bool { covered || childCovered }

  var body: some View {
    VStack(spacing: 0) {
      if !grabberHidden {
        grabber
      }
      content()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.deckBackground)
    .clipShape(RoundedRectangle(cornerRadius: StackedScene.cornerRadius, style: .continuous))
    .padding(.top, StackedScene.peek)
    .offset(y: max(0, dragOffset))
    .transition(.move(edge: .bottom))
    .onPreferenceChange(StackedSceneCoveredPreference.self) { childCovered = $0 }
  }

  private var grabber: some View {
    Capsule()
      .fill(Color.white.opacity(0.38))
      .frame(width: 36, height: 5)
      .frame(maxWidth: .infinity)
      .frame(height: StackedScene.grabberHeight)
      .contentShape(Rectangle())
      .highPriorityGesture(dismissDrag)
      .accessibilityLabel("Dismiss")
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { onDismiss() }
  }

  private var dismissDrag: some Gesture {
    DragGesture(minimumDistance: 2)
      .onChanged { value in
        dragOffset = max(0, value.translation.height)
      }
      .onEnded { value in
        let shouldDismiss = value.translation.height > StackedScene.dismissDistance
          || value.predictedEndTranslation.height > StackedScene.dismissVelocity
        if shouldDismiss {
          onDismiss()
        } else {
          withAnimation(StackedScene.animation) { dragOffset = 0 }
        }
      }
  }
}
