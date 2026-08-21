import DirectorCore
import DirectorPipeline
import PhotosUI
import SwiftUI

/// Live Output plus every overlay, so graphics can be placed on the picture they will burn into.
struct ContentEditorView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var addingWeb = false
  @State private var webURL = ""
  @State private var photoItem: PhotosPickerItem?
  @State private var editing: ProgramOverlay?

  var body: some View {
    NavigationStack {
      GeometryReader { geometry in
        let canvas = fittedCanvas(in: geometry.size)
        ZStack {
          Color.black
          ZStack(alignment: .topLeading) {
            CameraPreviewView(renderer: environment.router.programRenderer)
              .frame(width: canvas.width, height: canvas.height)
            OverlayAnchorLines(overlays: environment.overlays, canvas: canvas)
            ForEach(environment.overlays) { overlay in
              OverlayHandle(
                overlay: overlay,
                canvas: canvas,
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
                onEdit: { editing = overlay }
              )
            }
          }
          .coordinateSpace(name: "overlayEditor")
          .frame(width: canvas.width, height: canvas.height)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .background(Color.deckBackground)
      .navigationTitle("Add Content")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("content-editor-done")
        }
        ToolbarItemGroup(placement: .primaryAction) {
          Button("Web") {
            webURL = "https://"
            addingWeb = true
          }
          .accessibilityIdentifier("content-add-web")
          PhotosPicker(selection: $photoItem, matching: .images) {
            Text("Image")
          }
          .accessibilityIdentifier("content-add-image")
        }
      }
      .alert("Web view URL", isPresented: $addingWeb) {
        TextField("URL", text: $webURL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button("Add") {
          let trimmed = webURL.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else { return }
          environment.addWebOverlay(url: trimmed)
        }
        Button("Cancel", role: .cancel) {}
      }
      .onChange(of: photoItem) { _, item in
        Task { await importPhoto(item, replacing: editing?.id) }
      }
      .sheet(item: $editing) { overlay in
        OverlayEditSheet(
          overlay: overlay,
          photoItem: $photoItem,
          onSaveURL: { url in
            environment.updateOverlayURL(id: overlay.id, url: url)
            editing = nil
          },
          onDelete: {
            environment.removeOverlay(id: overlay.id)
            editing = nil
          }
        )
        .id(overlay.id)
      }
    }
  }

  private func fittedCanvas(in size: CGSize) -> CGSize {
    let width = CGFloat(environment.config.programResolution.width)
    let height = CGFloat(environment.config.programResolution.height)
    let scale = min(size.width / width, size.height / height)
    return CGSize(width: width * scale, height: height * scale)
  }

  private func importPhoto(_ item: PhotosPickerItem?, replacing: UUID?) async {
    defer {
      photoItem = nil
    }
    guard
      let item,
      let data = try? await item.loadTransferable(type: Data.self)
    else { return }
    let name = item.itemIdentifier ?? "Photo"
    if let replacing {
      environment.replaceOverlayImage(id: replacing, data: data, displayName: name)
    } else {
      environment.addImageOverlay(data: data, displayName: name)
    }
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
  let onMove: (CGPoint) -> Void
  let onMoveEnd: () -> Void
  let onResize: (CGRect) -> Void
  let onResizeEnd: () -> Void
  let onEdit: () -> Void

  @State private var dragOrigin: CGPoint?
  @State private var dragStartLocation: CGPoint?
  @State private var resizeStart: CGRect?
  @State private var resizeStartLocation: CGPoint?

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
          Text(label)
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .shadow(color: .black, radius: 2)
            .padding(4)
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
    }
    .frame(width: outer.width, height: outer.height)
    .position(x: rect.midX, y: rect.midY)
    .accessibilityIdentifier("overlay-handle-\(overlay.id.uuidString)")
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
    }
  }
}

private struct OverlayEditSheet: View {
  let overlay: ProgramOverlay
  @Binding var photoItem: PhotosPickerItem?
  let onSaveURL: (String) -> Void
  let onDelete: () -> Void

  @State private var url: String
  @Environment(\.dismiss) private var dismiss

  init(
    overlay: ProgramOverlay,
    photoItem: Binding<PhotosPickerItem?>,
    onSaveURL: @escaping (String) -> Void,
    onDelete: @escaping () -> Void
  ) {
    self.overlay = overlay
    _photoItem = photoItem
    self.onSaveURL = onSaveURL
    self.onDelete = onDelete
    _url = State(initialValue: overlay.url)
  }

  var body: some View {
    NavigationStack {
      Form {
        if overlay.kind == .web {
          Section("URL") {
            TextField("URL", text: $url)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .accessibilityIdentifier("overlay-edit-url")
          }
        } else {
          Section("Image") {
            Text(overlay.imageDisplayName.isEmpty ? overlay.imageFilename : overlay.imageDisplayName)
            PhotosPicker(selection: $photoItem, matching: .images) {
              Text("Choose another photo")
            }
            .accessibilityIdentifier("overlay-edit-image")
          }
        }
        Section {
          Button("Remove", role: .destructive, action: onDelete)
            .accessibilityIdentifier("overlay-edit-delete")
        }
      }
      .navigationTitle("Edit content")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        if overlay.kind == .web {
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") {
              onSaveURL(url.trimmingCharacters(in: .whitespacesAndNewlines))
            }
          }
        }
      }
    }
    .presentationDetents([.medium])
    .presentationDragIndicator(.hidden)
    .interactiveDismissDisabled()
    .onAppear { url = overlay.url }
  }
}