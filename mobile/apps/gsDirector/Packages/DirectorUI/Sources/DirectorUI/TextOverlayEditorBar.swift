import DirectorCore
import SwiftUI
import UIKit

struct TextOverlayEditorBar: View {
  @Environment(AppEnvironment.self) private var environment
  let overlay: ProgramOverlay
  @Binding var pickingFill: Bool
  @Binding var pickingShadow: Bool
  @Binding var sizeFieldFocused: Bool
  @State private var sizeDraft = ""
  @FocusState private var sizeFocused: Bool

  private var tapBlue: Color {
    Color(red: 0.45, green: 0.62, blue: 1)
  }

  var body: some View {
    HStack(spacing: 10) {
      Menu {
        Button("San Francisco") {
          environment.updateTextOverlay(id: overlay.id, fontName: "")
        }
        ForEach(UIFont.familyNames.sorted(), id: \.self) { family in
          Menu(family) {
            ForEach(UIFont.fontNames(forFamilyName: family), id: \.self) { name in
              Button(name) {
                environment.updateTextOverlay(id: overlay.id, fontName: name)
              }
            }
          }
        }
      } label: {
        Text(overlay.fontName.isEmpty ? "San Francisco" : overlay.fontName)
          .foregroundStyle(tapBlue)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }
      .accessibilityIdentifier("text-font-family")

      sizeField

      Button("B") {
        environment.updateTextOverlay(id: overlay.id, isBold: !overlay.isBold)
      }
      .fontWeight(.heavy)
      .foregroundStyle(overlay.isBold ? Color.programGreen : .white)
      .accessibilityIdentifier("text-bold")

      Button("I") {
        environment.updateTextOverlay(id: overlay.id, isItalic: !overlay.isItalic)
      }
      .italic()
      .foregroundStyle(overlay.isItalic ? Color.programGreen : .white)
      .accessibilityIdentifier("text-italic")

      alignButton(.left, identifier: "text-align-left")
      alignButton(.center, identifier: "text-align-center")
      alignButton(.right, identifier: "text-align-right")

      Button { pickingFill = true } label: {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(fillColor)
          .frame(width: 28, height: 28)
          .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
              .strokeBorder(Color.white.opacity(0.45), lineWidth: 1)
          )
      }
      .accessibilityIdentifier("text-color")
      .accessibilityLabel("Fill color")

      Button("Shadow") { pickingShadow = true }
        .foregroundStyle(tapBlue)
        .accessibilityIdentifier("text-shadow")
        .accessibilityLabel("Shadow")
    }
    .font(.system(size: 20, weight: .semibold))
    .foregroundStyle(.white)
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.deckPanel)
    .onAppear { sizeDraft = String(Int(overlay.fontSize.rounded())) }
    .onChange(of: overlay.fontSize) { _, value in
      let next = String(Int(value.rounded()))
      if sizeDraft != next { sizeDraft = next }
    }
    .onChange(of: sizeDraft) { _, value in
      guard let parsed = Double(value), parsed > 0 else { return }
      let clamped = min(max(parsed, 6), 200)
      if abs(clamped - overlay.fontSize) >= 0.5 {
        environment.updateTextOverlay(id: overlay.id, fontSize: clamped)
      }
    }
    .onChange(of: sizeFocused) { _, focused in
      sizeFieldFocused = focused
    }
  }

  private var sizeField: some View {
    TextField("108", text: $sizeDraft)
      .keyboardType(.numberPad)
      .multilineTextAlignment(.center)
      .focused($sizeFocused)
      .frame(width: 56)
      .padding(.vertical, 6)
      .padding(.horizontal, 6)
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
      )
      .accessibilityIdentifier("text-font-size-field")
      .overlay(alignment: .top) {
        if sizeFocused {
          Slider(
            value: Binding(
              get: { overlay.fontSize },
              set: { environment.updateTextOverlay(id: overlay.id, fontSize: $0) }
            ),
            in: 6 ... 200
          )
          .frame(width: UIScreen.main.bounds.width / 5)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
          .background(
            Color(red: 0.16, green: 0.16, blue: 0.18),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
          )
          .offset(y: 46)
          .accessibilityIdentifier("text-font-size")
        }
      }
      .zIndex(sizeFocused ? 2 : 0)
  }

  private var fillColor: Color {
    color(from: overlay.textColorHex)
  }

  private func color(from hex: String) -> Color {
    guard let rgb = OverlayColorHex.parse(hex) else { return .white }
    return Color(red: rgb.red, green: rgb.green, blue: rgb.blue)
  }

  private func alignButton(_ align: TextOverlayAlign, identifier: String) -> some View {
    Button {
      environment.updateTextOverlay(id: overlay.id, textAlign: align)
    } label: {
      Image(systemName: symbol(align))
        .foregroundStyle(overlay.textAlign == align ? Color.programGreen : .white)
    }
    .accessibilityIdentifier(identifier)
  }

  private func symbol(_ align: TextOverlayAlign) -> String {
    switch align {
    case .left: "text.alignleft"
    case .center: "text.aligncenter"
    case .right: "text.alignright"
    }
  }
}
