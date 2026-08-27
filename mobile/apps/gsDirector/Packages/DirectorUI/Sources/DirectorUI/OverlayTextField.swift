import SwiftUI
import UIKit

/// Invisible field that drives the software keyboard without the suggestion bar.
/// The UIKit caret is hidden; OverlayHandle draws one with `TextOverlayRenderer.caretRect`.
struct OverlayTextField: UIViewRepresentable {
  @Binding var text: String
  var font: UIFont
  var alignment: NSTextAlignment = .center
  var showsAccessory: Bool
  var claimsFocus: Bool
  var onDone: () -> Void
  var onCaretOffset: (Int) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(text: $text, onDone: onDone, onCaretOffset: onCaretOffset)
  }

  func makeUIView(context: Context) -> OverlayCaretField {
    let field = OverlayCaretField()
    field.delegate = context.coordinator
    field.text = text
    field.font = font
    applyClearTyping(field, font: font)
    field.textColor = .clear
    field.tintColor = .clear
    field.backgroundColor = .clear
    field.borderStyle = .none
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.spellCheckingType = .no
    field.smartQuotesType = .no
    field.smartDashesType = .no
    field.returnKeyType = .done
    field.textAlignment = alignment
    field.adjustsFontSizeToFitWidth = false
    field.minimumFontSize = 6
    field.clipsToBounds = false
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    field.setContentHuggingPriority(.defaultLow, for: .vertical)
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    field.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    field.inputAssistantItem.leadingBarButtonGroups = []
    field.inputAssistantItem.trailingBarButtonGroups = []
    if #available(iOS 17.0, *) {
      field.inlinePredictionType = .no
    }
    field.inputAccessoryView = showsAccessory ? context.coordinator.accessory : nil
    field.accessibilityIdentifier = "text-overlay-field"
    field.isAccessibilityElement = true
    field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
    return field
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: OverlayCaretField, context: Context) -> CGSize {
    CGSize(
      width: proposal.width ?? uiView.bounds.width,
      height: proposal.height ?? uiView.bounds.height
    )
  }

  func updateUIView(_ field: OverlayCaretField, context: Context) {
    context.coordinator.onDone = onDone
    context.coordinator.onCaretOffset = onCaretOffset
    if field.text != text { field.text = text }
    field.textAlignment = alignment
    applyClearTyping(field, font: font)
    field.font = font
    let accessory = showsAccessory ? context.coordinator.accessory : nil
    if field.inputAccessoryView !== accessory {
      field.inputAccessoryView = accessory
      if field.isFirstResponder {
        field.reloadInputViews()
      }
    }
    if claimsFocus {
      if !context.coordinator.didClaimFocus {
        context.coordinator.didClaimFocus = true
        if !field.isFirstResponder {
          field.becomeFirstResponder()
        }
      }
    } else {
      context.coordinator.didClaimFocus = false
      if field.isFirstResponder {
        field.resignFirstResponder()
      }
    }
    context.coordinator.reportCaret(field)
  }

  private func applyClearTyping(_ field: UITextField, font: UIFont) {
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: UIColor.clear
    ]
    field.defaultTextAttributes = attributes
    field.typingAttributes = attributes
  }

  final class Coordinator: NSObject, UITextFieldDelegate {
    var text: Binding<String>
    var onDone: () -> Void
    var onCaretOffset: (Int) -> Void
    var didClaimFocus = false
    let accessory: UIToolbar

    init(
      text: Binding<String>,
      onDone: @escaping () -> Void,
      onCaretOffset: @escaping (Int) -> Void
    ) {
      self.text = text
      self.onDone = onDone
      self.onCaretOffset = onCaretOffset
      let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 100, height: 44))
      bar.barStyle = .black
      let done = UIBarButtonItem(
        title: "Done",
        style: .done,
        target: nil,
        action: #selector(doneTapped)
      )
      done.accessibilityIdentifier = "text-overlay-done"
      bar.items = [
        UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil),
        done
      ]
      self.accessory = bar
      super.init()
      done.target = self
    }

    @objc func changed(_ field: UITextField) {
      text.wrappedValue = field.text ?? ""
      reportCaret(field)
    }

    func textFieldDidChangeSelection(_ textField: UITextField) {
      reportCaret(textField)
    }

    func reportCaret(_ field: UITextField) {
      let offset: Int
      if let range = field.selectedTextRange {
        offset = field.offset(from: field.beginningOfDocument, to: range.start)
      } else {
        offset = (field.text ?? "").utf16.count
      }
      DispatchQueue.main.async { [onCaretOffset] in
        onCaretOffset(offset)
      }
    }

    @objc func doneTapped() {
      onDone()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
      onDone()
      return false
    }
  }
}

final class OverlayCaretField: UITextField {
  override func textRect(forBounds bounds: CGRect) -> CGRect {
    bounds
  }

  override func editingRect(forBounds bounds: CGRect) -> CGRect {
    bounds
  }

  override func caretRect(for position: UITextPosition) -> CGRect {
    .zero
  }

  override func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
    []
  }
}
