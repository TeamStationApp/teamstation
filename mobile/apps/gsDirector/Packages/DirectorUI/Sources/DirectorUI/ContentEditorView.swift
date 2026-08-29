import DirectorCore
import DirectorPipeline
import PhotosUI
import SwiftUI
import UIKit

/// Live Output plus every overlay, so graphics can be placed on the picture they will burn into.
struct ContentEditorView: View {
  var onClose: () -> Void
  @Environment(AppEnvironment.self) private var environment

  @State private var showingList = false
  @State private var choosingKind = false
  @State private var photoItem: PhotosPickerItem?
  @State private var addShowInRewind = false
  @State private var addShowInLive = true
  @State private var editing: OverlayEditSession?
  @State private var showingRename = false
  @State private var renameText = ""
  @State private var pickingFill = false
  @State private var pickingShadow = false
  @State private var keyboardHeight: CGFloat = 0
  @State private var fontSizeFocused = false
  @State private var overlayFieldBlurred = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let overlay = editingTextOverlay {
          TextOverlayEditorBar(
            overlay: overlay,
            pickingFill: $pickingFill,
            pickingShadow: $pickingShadow,
            sizeFieldFocused: $fontSizeFocused
          )
          .zIndex(2)
        }
        GeometryReader { geometry in
        let canvas = fittedCanvas(in: geometry.size)
        ZStack {
          Color.black
            .contentShape(Rectangle())
            .onTapGesture { blurTextOverlayField() }
          ZStack(alignment: .topLeading) {
            CameraPreviewView(renderer: environment.router.programRenderer)
              .frame(width: canvas.width, height: canvas.height)
              .overlay {
                Color.clear
                  .contentShape(Rectangle())
                  .onTapGesture { blurTextOverlayField() }
              }
            OverlayAnchorLines(overlays: environment.overlays, canvas: canvas)
            ForEach(environment.overlays) { overlay in
              OverlayHandle(
                overlay: overlay,
                canvas: canvas,
                isEditingText: overlay.id == environment.editingTextOverlayID,
                text: overlay.kind == .text ? textBinding(for: overlay.id) : nil,
                displayScale: canvas.height
                  / max(CGFloat(environment.config.programResolution.height), 1),
                claimsFocus: overlay.id == environment.editingTextOverlayID
                  && !fontSizeFocused && !pickingFill && !pickingShadow && !overlayFieldBlurred,
                showsAccessory: softwareKeyboardVisible && !fontSizeFocused && !overlayFieldBlurred,
                onMove: { origin in
                  environment.moveOverlay(
                    id: overlay.id,
                    originX: origin.x,
                    originY: origin.y
                  )
                },
                onMoveEnd: {
                  environment.commitOverlayMove(id: overlay.id, displayCanvas: canvas)
                },
                onResize: { rect in
                  let normalized = OverlayLayout.normalized(rect, canvas: canvas)
                  environment.resizeOverlay(
                    id: overlay.id,
                    originX: normalized.originX,
                    originY: normalized.originY,
                    width: normalized.width,
                    height: normalized.height
                  )
                },
                onResizeEnd: {
                  environment.commitOverlayResize(id: overlay.id, displayCanvas: canvas)
                },
                onEdit: {
                  if overlay.kind == .text {
                    overlayFieldBlurred = false
                    environment.beginEditingTextOverlay(id: overlay.id)
                  } else {
                    environment.endEditingTextOverlay()
                    editing = .existing(overlay)
                  }
                },
                onEndTextEdit: { endTextEdit() }
              )
            }
          }
          .coordinateSpace(name: "overlayEditor")
          .frame(width: canvas.width, height: canvas.height)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .offset(y: canvasOffset(overlayCanvas: canvas, containerHeight: geometry.size.height))
      }
      .ignoresSafeArea(.keyboard)
      }
      .background(Color.deckBackground)
      .ignoresSafeArea(.keyboard)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(isEditingText ? .hidden : .visible, for: .navigationBar)
      .safeAreaInset(edge: .bottom) {
        if !isEditingText {
          ModalActionFooter(
            primaryTitle: "DONE",
            primaryIdentifier: "content-editor-done",
            action: {
              endTextEdit()
              onClose()
            }
          )
        }
      }
      .overlay(alignment: .bottomTrailing) {
        if isEditingText && (!softwareKeyboardVisible || fontSizeFocused) {
          ModalPrimaryButton(
            title: "DONE",
            identifier: "text-overlay-done",
            action: { endTextEdit() }
          )
          .padding(.horizontal, 16)
          .padding(.bottom, 8)
        }
      }
      .toolbar {
        ToolbarItem(placement: .principal) {
          HStack(spacing: 8) {
            Button {
              beginRename()
            } label: {
              Text(templateName)
                .font(.headline)
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("content-editor-rename-title")
            Button {
              beginRename()
            } label: {
              Image(systemName: "pencil")
            }
            .accessibilityIdentifier("content-editor-rename")
            .accessibilityLabel("Rename template")
          }
        }
        ToolbarItemGroup(placement: .primaryAction) {
          Button("List") { showingList = true }
            .accessibilityIdentifier("content-list")
          Button("Add") { choosingKind = true }
            .accessibilityIdentifier("content-add")
        }
      }
      .overlay {
        if choosingKind {
          addKindChooser
        }
        if showingRename {
          CenteredHover(onCancel: { showingRename = false }) {
            TemplateRenameSheet(
              title: "Rename template",
              name: $renameText,
              fieldIdentifier: "content-editor-rename-field",
              clearIdentifier: "content-editor-rename-clear",
              onCancel: { showingRename = false },
              onSave: {
                environment.renameTemplate(
                  id: environment.editingTemplateID ?? environment.activeTemplateID,
                  name: renameText
                )
                showingRename = false
              }
            )
          }
        }
        if pickingFill, let overlay = editingTextOverlay {
          CornerHover(alignment: .topLeading, onCancel: { pickingFill = false }) {
            DirectorColorPicker(
              hex: Binding(
                get: { overlay.textColorHex },
                set: { environment.updateTextOverlay(id: overlay.id, textColorHex: $0) }
              ),
              onDismiss: { pickingFill = false }
            )
          }
        }
        if pickingShadow, let overlay = editingTextOverlay {
          CornerHover(alignment: .topTrailing, onCancel: { pickingShadow = false }) {
            DirectorColorPicker(
              hex: Binding(
                get: { overlay.dropShadowColorHex },
                set: { environment.updateTextOverlay(id: overlay.id, dropShadowColorHex: $0) }
              ),
              shadowEnabled: Binding(
                get: { overlay.dropShadowEnabled },
                set: { environment.updateTextOverlay(id: overlay.id, dropShadowEnabled: $0) }
              ),
              onDismiss: { pickingShadow = false }
            )
          }
        }
      }
      .onChange(of: photoItem) { _, item in
        Task { await importPhoto(item) }
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) {
        keyboardHeight = Self.overlap(from: $0)
      }
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) {
        keyboardHeight = Self.overlap(from: $0)
      }
      .fullScreenCover(isPresented: $showingList) {
        OverlayListSheet()
          .environment(environment)
      }
      .fullScreenCover(item: $editing) { session in
        OverlayEditSheet(
          session: session,
          photoItem: $photoItem,
          onSaveURL: { url in
            switch session {
            case .add:
              environment.addWebOverlay(
                url: url,
                showInRewind: addShowInRewind,
                showInLive: addShowInLive
              )
            case .existing(let overlay):
              environment.updateOverlayURL(id: overlay.id, url: url)
            }
            editing = nil
          },
          onDelete: {
            if case .existing(let overlay) = session {
              environment.removeOverlay(id: overlay.id)
            }
            editing = nil
          }
        )
        .id(session.id)
      }
    }
  }

  private var templateName: String {
    let id = environment.editingTemplateID ?? environment.activeTemplateID
    return environment.templates.first { $0.id == id }?.name ?? OverlayTemplate.defaultName
  }

  private var addKindChooser: some View {
    ZStack {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture { choosingKind = false }
      VStack(spacing: 12) {
        Text("Add content")
          .font(.system(size: 15, weight: .heavy, design: .rounded))
          .tracking(1)
          .foregroundStyle(.white.opacity(0.7))
        addKindButton("Web", identifier: "content-add-web") {
          addShowInRewind = false
          addShowInLive = true
          choosingKind = false
          editing = .add(.web)
        }
        addKindButton("Image", identifier: "content-add-image") {
          addShowInRewind = false
          addShowInLive = true
          choosingKind = false
          editing = .add(.image)
        }
        addKindButton("Text", identifier: "content-add-text") {
          environment.endEditingTextOverlay()
          addShowInRewind = false
          addShowInLive = true
          choosingKind = false
          let id = environment.addTextOverlay(
            showInRewind: addShowInRewind,
            showInLive: addShowInLive
          )
          overlayFieldBlurred = false
          environment.beginEditingTextOverlay(id: id)
        }
        Button("Cancel") { choosingKind = false }
          .font(.system(size: 15, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.65))
          .padding(.top, 4)
      }
      .padding(28)
      .frame(width: 280)
      .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 16))
    }
  }

  private func addKindButton(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 17, weight: .semibold, design: .rounded))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .foregroundStyle(.white)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
  }

  private var isEditingText: Bool {
    environment.editingTextOverlayID != nil
  }

  private var softwareKeyboardVisible: Bool {
    isEditingText && !overlayFieldBlurred && !fontSizeFocused
  }

  /// Docked software-keyboard thickness. Notifications on this simulator often miss the strip, so
  /// while the overlay field is first responder we fall back to a landscape iPad estimate.
  private var effectiveKeyboardHeight: CGFloat {
    if keyboardHeight >= 80 { return keyboardHeight }
    guard softwareKeyboardVisible else { return 0 }
    let shortEdge = min(UIScreen.main.bounds.width, UIScreen.main.bounds.height)
    return shortEdge * 0.42
  }

  private func endTextEdit() {
    fontSizeFocused = false
    overlayFieldBlurred = false
    pickingFill = false
    pickingShadow = false
    environment.endEditingTextOverlay()
  }

  private func blurTextOverlayField() {
    guard isEditingText else { return }
    fontSizeFocused = false
    overlayFieldBlurred = true
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
  }

  private func beginRename() {
    renameText = templateName
    showingRename = true
  }

  private func canvasOffset(overlayCanvas: CGSize, containerHeight: CGFloat) -> CGFloat {
    guard let overlay = editingTextOverlay, softwareKeyboardVisible else { return 0 }
    let rect = OverlayLayout.pixelRect(overlay, canvas: overlayCanvas)
    let canvasTop = (containerHeight - overlayCanvas.height) / 2
    let overlayBottom = canvasTop + rect.maxY
    let accessory: CGFloat =
      (!fontSizeFocused && !overlayFieldBlurred) ? 44 : 0
    let lift = keyboardOverlap(in: containerHeight) + accessory
    let visibleBottom = containerHeight - lift - 20
    guard overlayBottom > visibleBottom else { return 0 }
    return visibleBottom - overlayBottom
  }

  /// Keyboard strip covering the bottom of the editor canvas, in the GeometryReader's space.
  private func keyboardOverlap(in containerHeight: CGFloat) -> CGFloat {
    let h = effectiveKeyboardHeight
    if h < 80 { return 0 }
    // GeometryReader already lost the keyboard strip; don't subtract it twice.
    if h >= containerHeight * 0.8 { return 0 }
    return min(h, containerHeight - 80)
  }

  private static func overlap(from notification: Notification) -> CGFloat {
    guard
      let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
    else { return 0 }
    let screen = UIScreen.main.bounds
    let scale = max(UIScreen.main.scale, 1)
    let inPoints = CGRect(
      x: frame.origin.x / scale,
      y: frame.origin.y / scale,
      width: frame.size.width / scale,
      height: frame.size.height / scale
    )
    let swapped = CGRect(x: 0, y: 0, width: screen.height, height: screen.width)
    return [
      intersectionThickness(frame, screen),
      intersectionThickness(frame, swapped),
      intersectionThickness(inPoints, screen),
      intersectionThickness(inPoints, swapped)
    ].max() ?? 0
  }

  private static func intersectionThickness(_ frame: CGRect, _ bounds: CGRect) -> CGFloat {
    let hit = bounds.intersection(frame)
    if hit.isNull || hit.isEmpty { return 0 }
    let thickness = min(hit.width, hit.height)
    return thickness >= 80 ? thickness : 0
  }

  private var editingTextOverlay: ProgramOverlay? {
    guard let id = environment.editingTextOverlayID else { return nil }
    return environment.overlays.first { $0.id == id }
  }

  private func textBinding(for id: UUID) -> Binding<String> {
    Binding(
      get: { environment.overlays.first(where: { $0.id == id })?.text ?? "" },
      set: { environment.updateTextOverlay(id: id, text: $0) }
    )
  }

  /// Aspect-fit the programme picture into the visible editor. Height-limited slots shrink the
  /// width evenly so the full frame stays on screen instead of cropping the top and bottom.
  private func fittedCanvas(in size: CGSize) -> CGSize {
    let width = CGFloat(environment.config.programResolution.width)
    let height = CGFloat(environment.config.programResolution.height)
    let slot = CGSize(width: max(size.width, 1), height: max(size.height, 1))
    let scale = min(slot.width / max(width, 1), slot.height / max(height, 1))
    return CGSize(width: width * scale, height: height * scale)
  }

  private func importPhoto(_ item: PhotosPickerItem?) async {
    defer { photoItem = nil }
    guard
      let item,
      let data = try? await item.loadTransferable(type: Data.self)
    else { return }
    let name = item.itemIdentifier ?? "Photo"
    switch editing {
    case .existing(let overlay):
      environment.replaceOverlayImage(id: overlay.id, data: data, displayName: name)
      editing = nil
    case .add:
      environment.addImageOverlay(
        data: data,
        displayName: name,
        showInRewind: addShowInRewind,
        showInLive: addShowInLive
      )
      editing = nil
    case .none:
      environment.addImageOverlay(data: data, displayName: name)
    }
  }
}

private enum OverlayEditSession: Identifiable {
  case add(ProgramOverlayKind)
  case existing(ProgramOverlay)

  var id: String {
    switch self {
    case .add(let kind): "add-\(kind.rawValue)"
    case .existing(let overlay): overlay.id.uuidString
    }
  }

  var kind: ProgramOverlayKind {
    switch self {
    case .add(let kind): kind
    case .existing(let overlay): overlay.kind
    }
  }

  var overlay: ProgramOverlay? {
    if case .existing(let overlay) = self { return overlay }
    return nil
  }
}

private struct OverlayListSheet: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var photoItem: PhotosPickerItem?
  @State private var editing: OverlayEditSession?

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 0, pinnedViews: .sectionHeaders) {
          Section {
            if environment.overlays.isEmpty {
              Text("No content yet. Tap Add.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .accessibilityIdentifier("content-list-empty")
            }
            ForEach(Array(environment.overlays.enumerated()), id: \.element.id) { index, overlay in
              HStack(alignment: .center, spacing: 12) {
                OverlayListThumb(
                  overlay: overlay,
                  image: environment.overlayPreviewUIImage(for: overlay)
                )
                Text(listTitle(overlay))
                  .lineLimit(2)
                  .frame(maxWidth: .infinity, alignment: .leading)
                Toggle(
                  "Show in Live",
                  isOn: Binding(
                    get: {
                      environment.overlays.first(where: { $0.id == overlay.id })?.showInLive ?? true
                    },
                    set: { environment.setOverlayShowInLive(id: overlay.id, showInLive: $0) }
                  )
                )
                .labelsHidden()
                .frame(width: 94)
                .accessibilityIdentifier("content-list-live-\(index + 1)")
                Toggle(
                  "Show in Rewind",
                  isOn: Binding(
                    get: {
                      environment.overlays.first(where: { $0.id == overlay.id })?.showInRewind ?? false
                    },
                    set: { environment.setOverlayShowInRewind(id: overlay.id, showInRewind: $0) }
                  )
                )
                .labelsHidden()
                .frame(width: 110)
                .accessibilityIdentifier("content-list-rewind-\(index + 1)")
                Button("Edit") {
                  if overlay.kind == .text {
                    environment.beginEditingTextOverlay(id: overlay.id)
                    dismiss()
                  } else {
                    editing = .existing(overlay)
                  }
                }
                .frame(width: 52, alignment: .trailing)
                .accessibilityIdentifier("content-list-edit-\(index + 1)")
              }
              .padding(.horizontal, 16)
              .padding(.vertical, 8)
              .accessibilityIdentifier("content-list-row-\(index + 1)")
            }
          } header: {
            HStack(alignment: .center, spacing: 12) {
              Text("Preview")
                .frame(width: 48, alignment: .leading)
              Text("Name")
                .frame(maxWidth: .infinity, alignment: .leading)
              Text("Show in Live")
                .frame(width: 94, alignment: .center)
                .multilineTextAlignment(.center)
              Text("Show in Rewind")
                .frame(width: 110, alignment: .center)
                .multilineTextAlignment(.center)
              Text("Edit")
                .frame(width: 52, alignment: .trailing)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color.deckBackground)
          }
        }
      }
      .background(Color.deckBackground)
      .navigationTitle("Content")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        ModalActionFooter(
          primaryTitle: "DONE",
          primaryIdentifier: "content-list-done",
          action: { dismiss() }
        )
      }
      .onChange(of: photoItem) { _, item in
        Task { await importPhoto(item) }
      }
      .fullScreenCover(item: $editing) { session in
        OverlayEditSheet(
          session: session,
          photoItem: $photoItem,
          onSaveURL: { url in
            if let overlay = session.overlay {
              environment.updateOverlayURL(id: overlay.id, url: url)
            }
            editing = nil
          },
          onDelete: {
            if let overlay = session.overlay {
              environment.removeOverlay(id: overlay.id)
            }
            editing = nil
          }
        )
        .id(session.id)
      }
    }
  }

  private func listTitle(_ overlay: ProgramOverlay) -> String {
    switch overlay.kind {
    case .web:
      overlay.url
    case .image:
      overlay.imageDisplayName.isEmpty ? overlay.imageFilename : overlay.imageDisplayName
    case .text:
      overlay.text.isEmpty ? "Text" : overlay.text
    }
  }

  private func importPhoto(_ item: PhotosPickerItem?) async {
    defer { photoItem = nil }
    guard
      let item,
      let data = try? await item.loadTransferable(type: Data.self),
      case .existing(let overlay) = editing
    else { return }
    let name = item.itemIdentifier ?? "Photo"
    environment.replaceOverlayImage(id: overlay.id, data: data, displayName: name)
    editing = nil
  }
}

private struct OverlayListThumb: View {
  let overlay: ProgramOverlay
  let image: UIImage?

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 6)
        .fill(Color(uiColor: .tertiarySystemFill))
      if let image {
        Image(uiImage: image)
          .resizable()
          .aspectRatio(contentMode: overlay.kind == .web ? .fill : .fit)
      } else {
        Image(systemName: overlay.kind == .web ? "globe" : overlay.kind == .text ? "textformat" : "photo")
          .foregroundStyle(.secondary)
      }
    }
    .frame(width: 48, height: 48)
    .clipShape(RoundedRectangle(cornerRadius: 6))
    .accessibilityHidden(true)
  }
}

private struct OverlayAnchorLines: View {
  let overlays: [ProgramOverlay]
  let canvas: CGSize

  var body: some View {
    Canvas { context, _ in
      for child in overlays {
        guard
          let parentID = child.anchorID,
          let edge = child.anchorEdge,
          let parent = overlays.first(where: { $0.id == parentID })
        else { continue }
        let (start, end) = OverlayLayout.linkLine(
          parent: OverlayLayout.pixelRect(parent, canvas: canvas),
          child: OverlayLayout.pixelRect(child, canvas: canvas),
          edge: edge
        )
        var path = Path()
        path.move(to: start)
        path.addLine(to: end)
        context.stroke(path, with: .color(.yellow), style: StrokeStyle(lineWidth: 3, lineCap: .round))
      }
    }
    .frame(width: canvas.width, height: canvas.height)
    .allowsHitTesting(false)
  }
}

private struct OverlayHandle: View {
  let overlay: ProgramOverlay
  let canvas: CGSize
  var isEditingText: Bool = false
  var text: Binding<String>?
  var displayScale: CGFloat = 1
  var claimsFocus: Bool = true
  var showsAccessory: Bool = true
  let onMove: (CGPoint) -> Void
  let onMoveEnd: () -> Void
  let onResize: (CGRect) -> Void
  let onResizeEnd: () -> Void
  let onEdit: () -> Void
  let onEndTextEdit: () -> Void

  /// UIKit insertion-point blink (~0.53s on, 0.53s off). Reset when the caret moves.
  private static let caretBlinkPeriod: TimeInterval = 0.53

  @State private var dragOrigin: CGPoint?
  @State private var dragStartLocation: CGPoint?
  @State private var resizeStart: CGRect?
  @State private var resizeStartLocation: CGPoint?
  @State private var caretUTF16 = 0
  @State private var caretBlinkEpoch = Date()

  var body: some View {
    let rect = OverlayLayout.pixelRect(overlay, canvas: canvas)
    let hit: CGFloat = 44
    let inset = hit / 2
    let outer = CGSize(width: max(rect.width, 24) + hit, height: max(rect.height, 24) + hit)
    ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: 3)
        .strokeBorder(Color.programGreen, lineWidth: 2)
        .background(Color.white.opacity(0.04))
        .overlay {
          if isEditingText, let text {
            OverlayTextField(
              text: text,
              font: TextOverlayRenderer.font(for: overlay, displayScale: displayScale),
              alignment: nsAlignment(overlay.textAlign),
              showsAccessory: showsAccessory,
              claimsFocus: claimsFocus,
              onDone: onEndTextEdit,
              onCaretOffset: { caretUTF16 = $0 }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(0.02)
            .allowsHitTesting(claimsFocus)
          } else {
            Text(label)
              .font(.system(size: 11, weight: .bold, design: .rounded))
              .foregroundStyle(.white)
              .shadow(color: .black, radius: 2)
              .padding(4)
          }
        }
        .padding(inset)
        .gesture(
          DragGesture(minimumDistance: 2, coordinateSpace: .named("overlayEditor"))
            .onChanged { value in
              if dragOrigin == nil {
                dragOrigin = CGPoint(x: overlay.originX, y: overlay.originY)
                dragStartLocation = value.startLocation
              }
              guard let origin = dragOrigin, let start = dragStartLocation else { return }
              onMove(
                CGPoint(
                  x: origin.x + (value.location.x - start.x) / canvas.width,
                  y: origin.y + (value.location.y - start.y) / canvas.height
                )
              )
            }
            .onEnded { _ in
              dragOrigin = nil
              dragStartLocation = nil
              onMoveEnd()
            }
        )
        .simultaneousGesture(
          LongPressGesture(minimumDuration: 0.55)
            .onEnded { _ in
              guard dragOrigin == nil else { return }
              onEdit()
            }
        )

      ForEach(OverlayLayout.Corner.allCases) { corner in
        cornerHandle(corner, overlayRect: rect, outer: outer, inset: inset)
      }
      if isEditingText && claimsFocus {
        let font = TextOverlayRenderer.font(for: overlay, displayScale: displayScale)
        let caret = TextOverlayRenderer.caretRect(
          text: overlay.text,
          font: font,
          align: overlay.textAlign,
          in: rect.size,
          utf16Offset: caretUTF16
        )
        TimelineView(.periodic(from: caretBlinkEpoch, by: Self.caretBlinkPeriod)) { context in
          let phase = context.date.timeIntervalSince(caretBlinkEpoch)
          let on = Int(phase / Self.caretBlinkPeriod) % 2 == 0
          Rectangle()
            .fill(Color.white)
            .opacity(on ? 1 : 0)
            .frame(width: caret.width, height: caret.height)
            .offset(x: inset + caret.minX, y: inset + caret.minY)
            .allowsHitTesting(false)
        }
      }
    }
    .frame(width: outer.width, height: outer.height)
    .position(x: rect.midX, y: rect.midY)
    .onChange(of: caretUTF16) { _, _ in caretBlinkEpoch = Date() }
    .onChange(of: overlay.text) { _, _ in caretBlinkEpoch = Date() }
    .onChange(of: claimsFocus) { _, focused in
      if focused { caretBlinkEpoch = Date() }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(isEditingText ? "text-overlay-field" : "overlay-handle-\(overlay.id.uuidString)")
  }

  private func cornerHandle(
    _ corner: OverlayLayout.Corner,
    overlayRect: CGRect,
    outer: CGSize,
    inset: CGFloat
  ) -> some View {
    let visual: CGFloat = 22
    let hit: CGFloat = 44
    let point = handlePoint(corner, in: outer, inset: inset)
    return ZStack {
      Circle()
        .fill(Color.programGreen)
        .frame(width: visual, height: visual)
    }
    .frame(width: hit, height: hit)
    .contentShape(Rectangle())
    .position(point)
    .highPriorityGesture(
        DragGesture(minimumDistance: 1, coordinateSpace: .named("overlayEditor"))
          .onChanged { value in
            if resizeStart == nil {
              resizeStart = overlayRect
              resizeStartLocation = value.startLocation
            }
            guard let start = resizeStart, let origin = resizeStartLocation else { return }
            let translation = CGSize(
              width: value.location.x - origin.x,
              height: value.location.y - origin.y
            )
            onResize(
              overlay.kind == .web
                ? OverlayLayout.scaledFromOrigin(start, translation: translation)
                : overlay.kind == .text
                  ? OverlayLayout.resizedFree(
                    start,
                    corner: corner,
                    translation: translation,
                    canvas: canvas
                  )
                  : OverlayLayout.resized(
                    start,
                    corner: corner,
                    translation: translation,
                    canvas: canvas
                  )
            )
          }
          .onEnded { _ in
            resizeStart = nil
            resizeStartLocation = nil
            onResizeEnd()
          }
      )
      .accessibilityIdentifier("overlay-resize-\(corner.rawValue)")
  }

  private func handlePoint(
    _ corner: OverlayLayout.Corner,
    in size: CGSize,
    inset: CGFloat
  ) -> CGPoint {
    switch corner {
    case .topLeft: CGPoint(x: inset, y: inset)
    case .topRight: CGPoint(x: size.width - inset, y: inset)
    case .bottomLeft: CGPoint(x: inset, y: size.height - inset)
    case .bottomRight: CGPoint(x: size.width - inset, y: size.height - inset)
    }
  }

  private var label: String {
    switch overlay.kind {
    case .web:
      "Web"
    case .image:
      overlay.imageDisplayName.isEmpty ? "Image" : overlay.imageDisplayName
    case .text:
      overlay.text.isEmpty ? "Text" : overlay.text
    }
  }

  private func nsAlignment(_ align: TextOverlayAlign) -> NSTextAlignment {
    switch align {
    case .left: .left
    case .center: .center
    case .right: .right
    }
  }
}

private struct OverlayEditSheet: View {
  let session: OverlayEditSession
  @Binding var photoItem: PhotosPickerItem?
  let onSaveURL: (String) -> Void
  let onDelete: () -> Void

  @State private var url: String
  @Environment(\.dismiss) private var dismiss

  init(
    session: OverlayEditSession,
    photoItem: Binding<PhotosPickerItem?>,
    onSaveURL: @escaping (String) -> Void,
    onDelete: @escaping () -> Void
  ) {
    self.session = session
    _photoItem = photoItem
    self.onSaveURL = onSaveURL
    self.onDelete = onDelete
    _url = State(initialValue: session.overlay?.url ?? "https://")
  }

  var body: some View {
    NavigationStack {
      Form {
        if session.kind == .web {
          Section("URL") {
            ClearableTextField(
              text: $url,
              clearIdentifier: "overlay-edit-url-clear"
            ) {
              TextField("URL", text: $url)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("overlay-edit-url")
            }
          }
        } else {
          Section("Image") {
            if let overlay = session.overlay {
              Text(
                overlay.imageDisplayName.isEmpty ? overlay.imageFilename : overlay.imageDisplayName
              )
            }
            PhotosPicker(selection: $photoItem, matching: .images) {
              Text(session.overlay == nil ? "Choose a photo" : "Choose another photo")
            }
            .accessibilityIdentifier("overlay-edit-image")
          }
        }
        if session.overlay != nil {
          Section {
            Button("Remove", role: .destructive, action: onDelete)
              .accessibilityIdentifier("overlay-edit-delete")
          }
        }
      }
      .navigationTitle("Edit content")
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        if session.kind == .web {
          ModalActionFooter(
            cancelTitle: "CANCEL",
            cancelIdentifier: "overlay-edit-cancel",
            onCancel: { dismiss() },
            primaryTitle: "SAVE",
            primaryIdentifier: "overlay-edit-save",
            action: {
              onSaveURL(url.trimmingCharacters(in: .whitespacesAndNewlines))
            }
          )
        } else {
          ModalActionFooter(
            primaryTitle: "DONE",
            primaryIdentifier: "overlay-edit-done",
            action: { dismiss() }
          )
        }
      }
    }
    .interactiveDismissDisabled()
  }
}
