import DirectorCore
import SwiftUI
import UIKit

struct DirectorColorPicker: View {
  @Binding var hex: String
  var shadowEnabled: Binding<Bool>? = nil
  var onDismiss: () -> Void

  @State private var mode: Mode = .grid
  @State private var red: Double = 1
  @State private var green: Double = 1
  @State private var blue: Double = 1
  @State private var hexDraft = ""
  @State private var cardOffset: CGSize = .zero
  @State private var dragOrigin: CGSize = .zero

  private enum Mode: String, CaseIterable, Identifiable {
    case grid = "Grid"
    case spectrum = "Spectrum"
    case sliders = "Sliders"
    var id: String { rawValue }
  }

  var body: some View {
    VStack(spacing: 14) {
      if let shadowEnabled {
        Toggle(isOn: shadowEnabled) {
          Text("Shadow enabled")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(.white)
        }
        .tint(Color.programGreen)
        .accessibilityIdentifier("text-shadow-enabled")
      }
      header
      modePicker
      Group {
        switch mode {
        case .grid: gridEditor
        case .spectrum: spectrumEditor
        case .sliders: slidersEditor
        }
      }
    }
    .padding(16)
    .frame(width: 420)
    .background(Color(red: 0.11, green: 0.11, blue: 0.12), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .offset(cardOffset)
    .onAppear { load(from: hex) }
  }

  private var header: some View {
    HStack {
      Color.clear
        .frame(width: 28, height: 28)
      Spacer()
      Text("Colors")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.white)
      Spacer()
      Button(action: onDismiss) {
        Image(systemName: "xmark")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: 28, height: 28)
      }
      .accessibilityIdentifier("color-picker-close")
      .accessibilityLabel("Close")
      .tint(.white)
    }
    .contentShape(Rectangle())
    .gesture(
      DragGesture()
        .onChanged { value in
          cardOffset = CGSize(
            width: dragOrigin.width + value.translation.width,
            height: dragOrigin.height + value.translation.height
          )
        }
        .onEnded { _ in
          dragOrigin = cardOffset
        }
    )
  }

  private var modePicker: some View {
    Picker("Mode", selection: $mode) {
      ForEach(Mode.allCases) { item in
        Text(item.rawValue).tag(item)
      }
    }
    .pickerStyle(.segmented)
    .accessibilityIdentifier("color-picker-mode")
  }

  private var selected: Color {
    Color(red: red, green: green, blue: blue)
  }

  private var gridEditor: some View {
    let rows = Self.gridSwatches
    return VStack(spacing: 3) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        HStack(spacing: 3) {
          ForEach(Array(row.enumerated()), id: \.offset) { _, swatch in
            let isSelected = Self.near(swatch, red: red, green: green, blue: blue)
            RoundedRectangle(cornerRadius: 2)
              .fill(Color(red: swatch.0, green: swatch.1, blue: swatch.2))
              .overlay {
                if isSelected {
                  RoundedRectangle(cornerRadius: 2)
                    .strokeBorder(Color.black, lineWidth: 3)
                }
              }
              .frame(height: 22)
              .onTapGesture {
                apply(red: swatch.0, green: swatch.1, blue: swatch.2)
              }
          }
        }
      }
    }
    .accessibilityIdentifier("color-picker-grid")
  }

  private var spectrumEditor: some View {
    GeometryReader { geo in
      Canvas { context, size in
        let steps = 80
        for y in 0..<steps {
          for x in 0..<steps {
            let hue = Double(y) / Double(steps - 1)
            let t = Double(x) / Double(steps - 1)
            let color = Self.spectrumColor(hue: hue, x: t)
            let rect = CGRect(
              x: CGFloat(x) / CGFloat(steps) * size.width,
              y: CGFloat(y) / CGFloat(steps) * size.height,
              width: size.width / CGFloat(steps) + 0.5,
              height: size.height / CGFloat(steps) + 0.5
            )
            context.fill(Path(rect), with: .color(color))
          }
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(alignment: .topLeading) {
        let point = Self.spectrumPoint(red: red, green: green, blue: blue, in: geo.size)
        Circle()
          .strokeBorder(Color.black.opacity(0.85), lineWidth: 3)
          .background(Circle().fill(selected))
          .frame(width: 18, height: 18)
          .offset(x: point.x - 9, y: point.y - 9)
      }
      .contentShape(Rectangle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { value in
            let x = min(max(value.location.x / geo.size.width, 0), 1)
            let y = min(max(value.location.y / geo.size.height, 0), 1)
            let rgb = Self.spectrumRGB(hue: Double(y), x: Double(x))
            apply(red: rgb.0, green: rgb.1, blue: rgb.2)
          }
      )
    }
    .frame(height: 280)
    .accessibilityIdentifier("color-picker-spectrum")
  }

  private var slidersEditor: some View {
    VStack(alignment: .leading, spacing: 14) {
      sliderRow("RED", value: $red, leading: Color(red: 0, green: green, blue: blue), trailing: Color(red: 1, green: green, blue: blue), identifier: "color-picker-rgb-r")
      sliderRow("GREEN", value: $green, leading: Color(red: red, green: 0, blue: blue), trailing: Color(red: red, green: 1, blue: blue), identifier: "color-picker-rgb-g")
      sliderRow("BLUE", value: $blue, leading: Color(red: red, green: green, blue: 0), trailing: Color(red: red, green: green, blue: 1), identifier: "color-picker-rgb-b")
      HStack(alignment: .bottom) {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(selected)
          .frame(width: 52, height: 52)
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .strokeBorder(Color.white.opacity(0.2), lineWidth: 1)
          )
          .accessibilityIdentifier("color-picker-preview")
        Spacer()
        VStack(alignment: .trailing, spacing: 6) {
          Text("sRGB Hex Color #")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Color(red: 0.45, green: 0.62, blue: 1))
          TextField("FFFFFF", text: $hexDraft)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .multilineTextAlignment(.center)
            .padding(.vertical, 6)
            .frame(width: 92)
            .background(Color.black, in: RoundedRectangle(cornerRadius: 6))
            .accessibilityIdentifier("color-picker-hex")
            .onChange(of: hexDraft) { _, value in
              if let rgb = OverlayColorHex.parse(value) {
                apply(red: rgb.red, green: rgb.green, blue: rgb.blue)
              }
            }
        }
      }
      .padding(.top, 8)
    }
    .accessibilityIdentifier("color-picker-rgb")
  }

  private func sliderRow(
    _ label: String,
    value: Binding<Double>,
    leading: Color,
    trailing: Color,
    identifier: String
  ) -> some View {
    let text = Binding(
      get: { String(Int((value.wrappedValue * 255).rounded())) },
      set: { draft in
        guard let parsed = Double(draft) else { return }
        value.wrappedValue = min(max(parsed / 255, 0), 1)
        apply(red: red, green: green, blue: blue)
      }
    )
    return VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(.white.opacity(0.55))
      HStack(spacing: 10) {
        Slider(value: value, in: 0 ... 1)
          .tint(.white)
          .background(
            LinearGradient(colors: [leading, trailing], startPoint: .leading, endPoint: .trailing)
              .clipShape(Capsule())
              .padding(.vertical, 7)
          )
          .onChange(of: value.wrappedValue) { _, _ in
            apply(red: red, green: green, blue: blue)
          }
        TextField("0", text: text)
          .keyboardType(.numberPad)
          .multilineTextAlignment(.center)
          .frame(width: 48)
          .padding(.vertical, 6)
          .background(Color.black, in: RoundedRectangle(cornerRadius: 6))
          .accessibilityIdentifier(identifier)
      }
    }
  }

  private func load(from hex: String) {
    hexDraft = hex.replacingOccurrences(of: "#", with: "")
    guard let rgb = OverlayColorHex.parse(hex) else { return }
    red = rgb.red
    green = rgb.green
    blue = rgb.blue
  }

  private func apply(red: Double, green: Double, blue: Double) {
    self.red = red
    self.green = green
    self.blue = blue
    hex = OverlayColorHex.format(red: red, green: green, blue: blue)
    hexDraft = hex.replacingOccurrences(of: "#", with: "")
  }

  private static func near(_ swatch: (Double, Double, Double), red: Double, green: Double, blue: Double) -> Bool {
    abs(swatch.0 - red) < 0.04 && abs(swatch.1 - green) < 0.04 && abs(swatch.2 - blue) < 0.04
  }

  private static func spectrumColor(hue: Double, x: Double) -> Color {
    let rgb = spectrumRGB(hue: hue, x: x)
    return Color(red: rgb.0, green: rgb.1, blue: rgb.2)
  }

  private static func spectrumRGB(hue: Double, x: Double) -> (Double, Double, Double) {
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    let sat: CGFloat
    let bright: CGFloat
    if x <= 0.5 {
      sat = x * 2
      bright = 1
    } else {
      sat = 1
      bright = 1 - ((x - 0.5) * 2)
    }
    UIColor(hue: hue, saturation: sat, brightness: bright, alpha: 1).getRed(&r, green: &g, blue: &b, alpha: nil)
    return (Double(r), Double(g), Double(b))
  }

  private static func spectrumPoint(red: Double, green: Double, blue: Double, in size: CGSize) -> CGPoint {
    var hue: CGFloat = 0
    var sat: CGFloat = 0
    var bright: CGFloat = 0
    UIColor(red: red, green: green, blue: blue, alpha: 1)
      .getHue(&hue, saturation: &sat, brightness: &bright, alpha: nil)
    let x: CGFloat
    if bright >= 1 - 0.001 {
      x = sat / 2
    } else {
      x = 0.5 + (1 - bright) / 2
    }
    return CGPoint(x: x * size.width, y: hue * size.height)
  }

  /// Grayscale row, then hue columns at decreasing brightness — close to the iOS Colors grid.
  private static let gridSwatches: [[(Double, Double, Double)]] = {
    var rows: [[(Double, Double, Double)]] = []
    rows.append((0..<12).map { i in
      let v = 1 - Double(i) / 11
      return (v, v, v)
    })
    let brightnesses: [Double] = [0.95, 0.82, 0.70, 0.58, 0.46, 0.36, 0.26, 0.18, 0.12, 0.08]
    for brightness in brightnesses {
      rows.append((0..<12).map { col in
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        let hue = Double(col) / 12
        UIColor(hue: hue, saturation: 0.85, brightness: brightness, alpha: 1)
          .getRed(&r, green: &g, blue: &b, alpha: nil)
        return (Double(r), Double(g), Double(b))
      })
    }
    return rows
  }()
}
