import DirectorCore
import DirectorPipeline
import PhotosUI
import SwiftUI
import UIKit

/// Live Output plus every overlay, so graphics can be placed on the picture they will burn into.
struct ContentEditorView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var showingList = false
  @State private var choosingKind = false
  @State private var photoItem: PhotosPickerItem?
  @State private var addShowInRewind = false
  @State private var editing: OverlayEditSession?

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
                onEdit: { editing = .existing(overlay) }
              )
            }
          }
          .coordinateSpace(name: "overlayEditor")
          .frame(width: canvas.width, height: canvas.height)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .background(Color.deckBackground)
      .navigationTitle("Add/Edit Content")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("content-editor-done")
        }
        ToolbarItemGroup(placement: .primaryAction) {
          Button("List") { showingList = true }
            .accessibilityIdentifier("content-list")
          Button("Add") { choosingKind = true }
            .accessibilityIdentifier("content-add")
        }
      }
      .confirmationDialog("Add content", isPresented: $choosingKind, titleVisibility: .visible) {
        Button("Web") {
          addShowInRewind = false
          editing = .add(.web)
        }
        .accessibilityIdentifier("content-add-web")
        Button("Image") {
          addShowInRewind = false
          editing = .add(.image)
        }
        .accessibilityIdentifier("content-add-image")
        Button("Cancel", role: .cancel) {}
      }
      .onChange(of: photoItem) { _, item in
        Task { await importPhoto(item) }
      }
      .sheet(isPresented: $showingList) {
        OverlayListSheet()
          .environment(environment)
      }
      .sheet(item: $editing) { session in
        OverlayEditSheet(
          session: session,
          photoItem: $photoItem,
          showInRewind: showInRewindBinding(for: session),
          onSaveURL: { url, showInRewind in
            switch session {
            case .add:
              environment.addWebOverlay(url: url, showInRewind: showInRewind)
            case .existing(let overlay):
              environment.updateOverlayURL(id: overlay.id, url: url)
              environment.setOverlayShowInRewind(id: overlay.id, showInRewind: showInRewind)
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

  private func showInRewindBinding(for session: OverlayEditSession) -> Binding<Bool> {
    switch session {
    case .add:
      return $addShowInRewind
    case .existing(let overlay):
      return Binding(
        get: {
          environment.overlays.first(where: { $0.id == overlay.id })?.showInRewind
            ?? overlay.showInRewind
        },
        set: { environment.setOverlayShowInRewind(id: overlay.id, showInRewind: $0) }
      )
    }
  }

  private func fittedCanvas(in size: CGSize) -> CGSize {
    let width = CGFloat(environment.config.programResolution.width)
    let height = CGFloat(environment.config.programResolution.height)
    let scale = min(size.width / width, size.height / height)
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
      environment.addImageOverlay(data: data, displayName: name, showInRewind: addShowInRewind)
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
      List {
        if environment.overlays.isEmpty {
          Text("No content yet. Tap Add.")
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("content-list-empty")
        }
        ForEach(Array(environment.overlays.enumerated()), id: \.element.id) { index, overlay in
          VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
              OverlayListThumb(
                overlay: overlay,
                image: environment.overlayPreviewUIImage(for: overlay)
              )
              Text(listTitle(overlay))
                .lineLimit(2)
              Spacer()
              Button("Edit") { editing = .existing(overlay) }
                .accessibilityIdentifier("content-list-edit-\(index + 1)")
            }
            Toggle(
              "Show in rewind",
              isOn: Binding(
                get: {
                  environment.overlays.first(where: { $0.id == overlay.id })?.showInRewind ?? false
                },
                set: { environment.setOverlayShowInRewind(id: overlay.id, showInRewind: $0) }
              )
            )
            .accessibilityIdentifier("content-list-rewind-\(index + 1)")
          }
          .accessibilityIdentifier("content-list-row-\(index + 1)")
        }
      }
      .navigationTitle("Content")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("content-list-done")
        }
      }
      .onChange(of: photoItem) { _, item in
        Task { await importPhoto(item) }
      }
      .sheet(item: $editing) { session in
        OverlayEditSheet(
          session: session,
          photoItem: $photoItem,
          showInRewind: Binding(
            get: {
              environment.overlays.first(where: { $0.id == session.overlay?.id })?.showInRewind
                ?? false
            },
            set: { value in
              if let id = session.overlay?.id {
                environment.setOverlayShowInRewind(id: id, showInRewind: value)
              }
            }
          ),
          onSaveURL: { url, showInRewind in
            if let overlay = session.overlay {
              environment.updateOverlayURL(id: overlay.id, url: url)
              environment.setOverlayShowInRewind(id: overlay.id, showInRewind: showInRewind)
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
    .presentationDetents([.medium, .large])
  }

  private func listTitle(_ overlay: ProgramOverlay) -> String {
    switch overlay.kind {
    case .web:
      overlay.url
    case .image:
      overlay.imageDisplayName.isEmpty ? overlay.imageFilename : overlay.imageDisplayName
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
          .aspectRatio(contentMode: overlay.kind == .image ? .fit : .fill)
      } else {
        Image(systemName: overlay.kind == .web ? "globe" : "photo")
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
  let session: OverlayEditSession
  @Binding var photoItem: PhotosPickerItem?
  @Binding var showInRewind: Bool
  let onSaveURL: (String, Bool) -> Void
  let onDelete: () -> Void

  @State private var url: String
  @Environment(\.dismiss) private var dismiss

  init(
    session: OverlayEditSession,
    photoItem: Binding<PhotosPickerItem?>,
    showInRewind: Binding<Bool>,
    onSaveURL: @escaping (String, Bool) -> Void,
    onDelete: @escaping () -> Void
  ) {
    self.session = session
    _photoItem = photoItem
    _showInRewind = showInRewind
    self.onSaveURL = onSaveURL
    self.onDelete = onDelete
    _url = State(initialValue: session.overlay?.url ?? "https://")
  }

  var body: some View {
    NavigationStack {
      Form {
        if session.kind == .web {
          Section("URL") {
            TextField("URL", text: $url)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .accessibilityIdentifier("overlay-edit-url")
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
        Section {
          Toggle("Show in rewind", isOn: $showInRewind)
            .accessibilityIdentifier("overlay-edit-rewind")
        } footer: {
          Text("Off: live Output only. On: also during scrub and Instant Replay.")
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
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        if session.kind == .web {
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") {
              onSaveURL(url.trimmingCharacters(in: .whitespacesAndNewlines), showInRewind)
            }
            .accessibilityIdentifier("overlay-edit-save")
          }
        }
      }
    }
    .presentationDetents([.medium])
    .presentationDragIndicator(.hidden)
    .interactiveDismissDisabled()
  }
}
