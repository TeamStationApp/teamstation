import CoreGraphics
import Foundation

public enum ProgramOverlayKind: String, Sendable, Codable, Hashable {
  case web
  case image
}

public enum OverlayAnchorEdge: String, Sendable, Codable, Hashable {
  case right
  case bottom
}

/// How a new overlay picks its first rectangle on the programme canvas.
public enum OverlayPlacement: String, Sendable, Codable, Hashable {
  /// Centered, scaled so the larger axis is a quarter of the canvas.
  case centerQuarter
  /// Native snapshot size, parked at the compositor's top-left inset.
  case topLeftNative
}

/// One graphic burned into Output: a web snapshot or a still image.
public struct ProgramOverlay: Sendable, Codable, Identifiable, Hashable {
  public var id: UUID
  public var kind: ProgramOverlayKind
  public var url: String
  public var imageFilename: String
  public var imageDisplayName: String
  /// Top-left of the overlay, as a fraction of the programme frame.
  public var originX: Double
  public var originY: Double
  /// Display size as a fraction of the programme frame.
  public var width: Double
  public var height: Double
  /// Uniform zoom for web overlays. The page is snapshotted at its natural size; this only scales
  /// the drawing, so growing content is not cropped to a box.
  public var scale: Double
  /// Last measured page size, in output pixels. Zero until the first snapshot.
  public var nativeWidth: Double
  public var nativeHeight: Double
  /// When set, this overlay is parked against a web view and moves when that page grows.
  public var anchorID: UUID?
  public var anchorEdge: OverlayAnchorEdge?
  /// Gap from the parent's right or bottom edge to this overlay, in output pixels.
  public var anchorGap: Double
  public var placement: OverlayPlacement
  public var role: String?
  public var hasLaidOut: Bool
  /// When false, the graphic is live Output only and collapses to zero size during scrub and
  /// Instant Replay so attached children move with it. When true, it also burns in off-live.
  public var showInRewind: Bool

  public init(
    id: UUID = UUID(),
    kind: ProgramOverlayKind,
    url: String = "",
    imageFilename: String = "",
    imageDisplayName: String = "",
    originX: Double,
    originY: Double,
    width: Double,
    height: Double,
    scale: Double = 1,
    nativeWidth: Double = 0,
    nativeHeight: Double = 0,
    anchorID: UUID? = nil,
    anchorEdge: OverlayAnchorEdge? = nil,
    anchorGap: Double = 0,
    placement: OverlayPlacement,
    role: String? = nil,
    hasLaidOut: Bool = false,
    showInRewind: Bool = false
  ) {
    self.id = id
    self.kind = kind
    self.url = url
    self.imageFilename = imageFilename
    self.imageDisplayName = imageDisplayName
    self.originX = originX
    self.originY = originY
    self.width = width
    self.height = height
    self.scale = scale
    self.nativeWidth = nativeWidth
    self.nativeHeight = nativeHeight
    self.anchorID = anchorID
    self.anchorEdge = anchorEdge
    self.anchorGap = anchorGap
    self.placement = placement
    self.role = role
    self.hasLaidOut = hasLaidOut
    self.showInRewind = showInRewind
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
    kind = try container.decodeIfPresent(ProgramOverlayKind.self, forKey: .kind) ?? .web
    url = try container.decodeIfPresent(String.self, forKey: .url) ?? ""
    imageFilename = try container.decodeIfPresent(String.self, forKey: .imageFilename) ?? ""
    imageDisplayName = try container.decodeIfPresent(String.self, forKey: .imageDisplayName) ?? ""
    originX = try container.decodeIfPresent(Double.self, forKey: .originX) ?? 0
    originY = try container.decodeIfPresent(Double.self, forKey: .originY) ?? 0
    width = try container.decodeIfPresent(Double.self, forKey: .width) ?? 0.25
    height = try container.decodeIfPresent(Double.self, forKey: .height) ?? 0.25
    scale = try container.decodeIfPresent(Double.self, forKey: .scale) ?? 1
    nativeWidth = try container.decodeIfPresent(Double.self, forKey: .nativeWidth) ?? 0
    nativeHeight = try container.decodeIfPresent(Double.self, forKey: .nativeHeight) ?? 0
    anchorID = try container.decodeIfPresent(UUID.self, forKey: .anchorID)
    anchorEdge = try container.decodeIfPresent(OverlayAnchorEdge.self, forKey: .anchorEdge)
    anchorGap = try container.decodeIfPresent(Double.self, forKey: .anchorGap) ?? 0
    placement = try container.decodeIfPresent(OverlayPlacement.self, forKey: .placement)
      ?? .centerQuarter
    role = try container.decodeIfPresent(String.self, forKey: .role)
    hasLaidOut = try container.decodeIfPresent(Bool.self, forKey: .hasLaidOut) ?? false
    showInRewind = try container.decodeIfPresent(Bool.self, forKey: .showInRewind) ?? false
  }
}

public enum OverlayLayout {
  public static let quarter: CGFloat = 0.25
  public static let topLeftInset = CGPoint(x: 20, y: 20)
  /// Overlays this close to a web view's right or bottom edge become relative to it.
  public static let anchorSnapPixels: CGFloat = 20

  /// Uniform scale so the larger axis is 25% of the canvas, then centered.
  public static func centerQuarter(native: CGSize, canvas: CGSize) -> CGRect {
    let safeNative = CGSize(
      width: max(native.width, 1),
      height: max(native.height, 1)
    )
    let scale = min(
      (canvas.width * quarter) / safeNative.width,
      (canvas.height * quarter) / safeNative.height
    )
    let size = CGSize(width: safeNative.width * scale, height: safeNative.height * scale)
    return CGRect(
      x: (canvas.width - size.width) / 2,
      y: (canvas.height - size.height) / 2,
      width: size.width,
      height: size.height
    )
  }

  public static func topLeftNative(native: CGSize, canvas: CGSize) -> CGRect {
    let width = min(max(native.width, 1), canvas.width - topLeftInset.x)
    let height = min(max(native.height, 1), canvas.height - topLeftInset.y)
    return CGRect(x: topLeftInset.x, y: topLeftInset.y, width: width, height: height)
  }

  public static func scaleFittingQuarter(native: CGSize, canvas: CGSize) -> Double {
    let safeNative = CGSize(width: max(native.width, 1), height: max(native.height, 1))
    return Double(
      min(
        (canvas.width * quarter) / safeNative.width,
        (canvas.height * quarter) / safeNative.height
      )
    )
  }

  public static func normalized(_ rect: CGRect, canvas: CGSize) -> (
    originX: Double,
    originY: Double,
    width: Double,
    height: Double
  ) {
    let canvasWidth = max(canvas.width, 1)
    let canvasHeight = max(canvas.height, 1)
    return (
      Double(rect.origin.x / canvasWidth),
      Double(rect.origin.y / canvasHeight),
      Double(rect.width / canvasWidth),
      Double(rect.height / canvasHeight)
    )
  }

  /// Normalised width/height for a web overlay: natural page size times the user's scale,
  /// as a fraction of the programme canvas.
  public static func scaledNormalized(
    native: CGSize,
    scale: Double,
    canvas: CGSize
  ) -> (width: Double, height: Double) {
    (
      Double(native.width * scale) / Double(max(canvas.width, 1)),
      Double(native.height * scale) / Double(max(canvas.height, 1))
    )
  }

  /// CSS shrink-wrap when the page reported one; otherwise the snapshot converted to points.
  ///
  /// `takeSnapshot` sometimes returns a 1× `UIImage.scale` for the first off-screen capture even
  /// when the bitmap is retina. Dividing only by that scale treats pixels as points and the overlay
  /// jumps to about twice the saved size until a later layout (the content editor) recaptures it.
  public static func webNativeSize(
    measured: CGSize,
    pixelWidth: CGFloat,
    pixelHeight: CGFloat,
    imageScale: CGFloat,
    displayScale: CGFloat
  ) -> CGSize {
    if measured.width >= 1, measured.height >= 1 {
      return CGSize(width: measured.width.rounded(.up), height: measured.height.rounded(.up))
    }
    let scale = max(imageScale, displayScale, 1)
    return CGSize(width: pixelWidth / scale, height: pixelHeight / scale)
  }

  public static func nativesAgree(
    _ a: CGSize,
    _ b: CGSize,
    tolerance: CGFloat = 0.08
  ) -> Bool {
    guard a.width >= 1, a.height >= 1, b.width >= 1, b.height >= 1 else { return false }
    let widthDelta = abs(a.width - b.width) / max(a.width, b.width)
    let heightDelta = abs(a.height - b.height) / max(a.height, b.height)
    return widthDelta <= tolerance && heightDelta <= tolerance
  }

  /// True when `incoming` is the saved page at 2× or 3× — a display-scale artifact, not growth.
  public static func isDisplayScaleArtifact(saved: CGSize, incoming: CGSize) -> Bool {
    guard saved.width >= 1, saved.height >= 1, incoming.width >= 1, incoming.height >= 1 else {
      return false
    }
    let widthRatio = incoming.width / saved.width
    let heightRatio = incoming.height / saved.height
    for factor in [CGFloat(2), CGFloat(3)] {
      if abs(widthRatio - factor) <= 0.08, abs(heightRatio - factor) <= 0.08 {
        return true
      }
    }
    return false
  }

  /// How a new page measure should affect a web overlay that already has a saved native size.
  public struct WebNativeResolution: Equatable, Sendable {
    public var native: CGSize
    public var pending: CGSize?
    public var applyLayout: Bool

    public init(native: CGSize, pending: CGSize?, applyLayout: Bool) {
      self.native = native
      self.pending = pending
      self.applyLayout = applyLayout
    }
  }

  /// True when the shrink-wrap failed and reported the web view itself.
  public static func isViewportFilling(_ size: CGSize, viewport: CGSize) -> Bool {
    guard size.width >= 1, viewport.width >= 1 else { return false }
    return size.width >= viewport.width * 0.98
  }

  /// Keep the saved box until a measure matches it or is clearly smaller (finished CSS). Two
  /// identical larger snapshots are not enough — MutationObserver fires twice on load before the
  /// page has shrink-wrapped, which is what still made Output jump after the first snapshot was
  /// ignored.
  public static func resolveWebNative(
    incoming: CGSize,
    saved: CGSize,
    pending: CGSize?,
    savedConfirmed: Bool = false,
    viewport: CGSize = .zero
  ) -> WebNativeResolution {
    if saved.width < 1 || saved.height < 1 {
      return WebNativeResolution(native: incoming, pending: nil, applyLayout: true)
    }
    if isViewportFilling(incoming, viewport: viewport) {
      return WebNativeResolution(native: saved, pending: pending, applyLayout: false)
    }
    if nativesAgree(saved, incoming) {
      return WebNativeResolution(native: incoming, pending: nil, applyLayout: true)
    }
    if isDisplayScaleArtifact(saved: saved, incoming: incoming) {
      return WebNativeResolution(native: saved, pending: nil, applyLayout: true)
    }
    if incoming.width + 1 < saved.width * 0.72 {
      return WebNativeResolution(native: incoming, pending: nil, applyLayout: true)
    }
    if savedConfirmed, let pending, nativesAgree(pending, incoming) {
      return WebNativeResolution(native: incoming, pending: nil, applyLayout: true)
    }
    return WebNativeResolution(native: saved, pending: incoming, applyLayout: false)
  }

  public static func pixelRect(_ overlay: ProgramOverlay, canvas: CGSize) -> CGRect {
    CGRect(
      x: overlay.originX * canvas.width,
      y: overlay.originY * canvas.height,
      width: overlay.width * canvas.width,
      height: overlay.height * canvas.height
    )
  }

  /// Programme-canvas rectangles after live-only overlays collapse off-live. Does not mutate
  /// stored overlay size; attached children are re-parked against the collapsed parent.
  public static func displayRects(
    overlays: [ProgramOverlay],
    canvas: CGSize,
    programIsOffLive: Bool
  ) -> [UUID: CGRect] {
    var rects: [UUID: CGRect] = [:]
    var collapsedAny = false
    for overlay in overlays {
      var rect = pixelRect(overlay, canvas: canvas)
      if OverlayVisibility.shouldCollapse(
        showInRewind: overlay.showInRewind,
        programIsOffLive: programIsOffLive
      ) {
        rect.size = .zero
        collapsedAny = true
      }
      rects[overlay.id] = rect
    }
    guard collapsedAny else { return rects }

    func applyChildren(of parentID: UUID, depth: Int) {
      guard depth < 16, let parentRect = rects[parentID] else { return }
      for overlay in overlays {
        guard overlay.anchorID == parentID, let edge = overlay.anchorEdge else { continue }
        guard var childRect = rects[overlay.id] else { continue }
        let origin = anchoredOrigin(
          parent: parentRect,
          child: childRect,
          edge: edge,
          gap: CGFloat(overlay.anchorGap)
        )
        childRect.origin = origin
        rects[overlay.id] = childRect
        applyChildren(of: overlay.id, depth: depth + 1)
      }
    }

    for overlay in overlays where overlay.anchorID == nil {
      applyChildren(of: overlay.id, depth: 0)
    }
    return rects
  }

  /// Scale the rect from its top-left. Web overlays grow right and down; they are not cropped
  /// to the canvas.
  public static func scaledFromOrigin(
    _ rect: CGRect,
    translation: CGSize,
    minimum: CGFloat = 40
  ) -> CGRect {
    let aspect = rect.width / max(rect.height, 1)
    let width = max(rect.width + translation.width, minimum)
    let height = width / aspect
    return CGRect(x: rect.origin.x, y: rect.origin.y, width: width, height: height)
  }

  public enum Corner: String, Sendable, CaseIterable, Identifiable {
    case topLeft, topRight, bottomLeft, bottomRight

    public var id: String { rawValue }
  }

  /// Aspect-locked resize around the opposite corner. Width is the independent axis; height follows.
  public static func resized(
    _ rect: CGRect,
    corner: Corner,
    translation: CGSize,
    canvas: CGSize,
    minimum: CGFloat = 40
  ) -> CGRect {
    let aspect = rect.width / max(rect.height, 1)
    var width: CGFloat
    switch corner {
    case .bottomRight, .topRight:
      width = rect.width + translation.width
    case .bottomLeft, .topLeft:
      width = rect.width - translation.width
    }
    width = min(max(width, minimum), canvas.width)
    let height = width / aspect

    var x: CGFloat
    var y: CGFloat
    switch corner {
    case .bottomRight:
      x = rect.minX
      y = rect.minY
    case .bottomLeft:
      x = rect.maxX - width
      y = rect.minY
    case .topRight:
      x = rect.minX
      y = rect.maxY - height
    case .topLeft:
      x = rect.maxX - width
      y = rect.maxY - height
    }

    x = min(max(x, 0), canvas.width - width)
    y = min(max(y, 0), canvas.height - height)
    return CGRect(x: x, y: y, width: width, height: height)
  }

  /// If `child` sits just to the right or just below `parent`, return that edge and the gap.
  public static func attachment(
    parent: CGRect,
    child: CGRect,
    snap: CGFloat = anchorSnapPixels
  ) -> (edge: OverlayAnchorEdge, gap: CGFloat)? {
    let rightGap = child.minX - parent.maxX
    let bottomGap = child.minY - parent.maxY
    let verticalOverlap = min(parent.maxY, child.maxY) - max(parent.minY, child.minY)
    let horizontalOverlap = min(parent.maxX, child.maxX) - max(parent.minX, child.minX)
    let rightFits = abs(rightGap) <= snap && verticalOverlap > -snap && child.midX >= parent.midX
    let bottomFits = abs(bottomGap) <= snap && horizontalOverlap > -snap && child.midY >= parent.midY
    if rightFits && bottomFits {
      return abs(rightGap) <= abs(bottomGap)
        ? (.right, rightGap)
        : (.bottom, bottomGap)
    }
    if rightFits { return (.right, rightGap) }
    if bottomFits { return (.bottom, bottomGap) }
    return nil
  }

  public static func anchoredOrigin(
    parent: CGRect,
    child: CGRect,
    edge: OverlayAnchorEdge,
    gap: CGFloat
  ) -> CGPoint {
    switch edge {
    case .right:
      return CGPoint(x: parent.maxX + gap, y: child.origin.y)
    case .bottom:
      return CGPoint(x: child.origin.x, y: parent.maxY + gap)
    }
  }

  public static func linkLine(
    parent: CGRect,
    child: CGRect,
    edge: OverlayAnchorEdge
  ) -> (CGPoint, CGPoint) {
    switch edge {
    case .right:
      let y = (max(parent.minY, child.minY) + min(parent.maxY, child.maxY)) / 2
      return (CGPoint(x: parent.maxX, y: y), CGPoint(x: child.minX, y: y))
    case .bottom:
      let x = (max(parent.minX, child.minX) + min(parent.maxX, child.maxX)) / 2
      return (CGPoint(x: x, y: parent.maxY), CGPoint(x: x, y: child.minY))
    }
  }

  /// Top-left square of a content-sized web snapshot, side min(width, height).
  public static func webThumbnailCrop(contentSize: CGSize) -> CGRect {
    let side = min(contentSize.width, contentSize.height)
    guard side >= 1 else { return .zero }
    return CGRect(x: 0, y: 0, width: side, height: side)
  }
}
