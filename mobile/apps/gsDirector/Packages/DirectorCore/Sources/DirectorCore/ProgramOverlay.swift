import CoreGraphics
import Foundation

public enum ProgramOverlayKind: String, Sendable, Codable, Hashable {
  case web
  case image
  case text
}

public enum TextOverlayAlign: String, Sendable, Codable, Hashable, CaseIterable, Identifiable {
  case left
  case center
  case right

  public var id: String { rawValue }
}

/// `#RGB` / `#RRGGBB` fill values used by text overlays and the color picker.
public enum OverlayColorHex {
  public static func parse(_ hex: String) -> (red: Double, green: Double, blue: Double)? {
    var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("#") { value.removeFirst() }
    value = value.uppercased()
    if value.count == 3 {
      value = value.map { "\($0)\($0)" }.joined()
    }
    guard value.count == 6, let packed = UInt32(value, radix: 16) else { return nil }
    return (
      Double((packed >> 16) & 0xFF) / 255,
      Double((packed >> 8) & 0xFF) / 255,
      Double(packed & 0xFF) / 255
    )
  }

  public static func format(red: Double, green: Double, blue: Double) -> String {
    func byte(_ component: Double) -> Int {
      Int((min(max(component, 0), 1) * 255).rounded())
    }
    return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
  }
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
  /// When false, the graphic is hidden on live Output and only appears during scrub / Instant Replay.
  public var showInLive: Bool
  public var text: String
  public var fontName: String
  public var fontSize: Double
  public var isBold: Bool
  public var isItalic: Bool
  public var textAlign: TextOverlayAlign
  /// When true, the box width/height follow the glyphs. The first corner-drag turns this off.
  public var hugText: Bool
  public var textColorHex: String
  public var dropShadowEnabled: Bool
  public var dropShadowColorHex: String

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
    showInRewind: Bool = false,
    showInLive: Bool = true,
    text: String = "",
    fontName: String = "",
    fontSize: Double = 0,
    isBold: Bool = false,
    isItalic: Bool = false,
    textAlign: TextOverlayAlign = .center,
    hugText: Bool = true,
    textColorHex: String = "#FFFFFF",
    dropShadowEnabled: Bool = false,
    dropShadowColorHex: String = "#000000"
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
    self.showInLive = showInLive
    self.text = text
    self.fontName = fontName
    self.fontSize = fontSize
    self.isBold = isBold
    self.isItalic = isItalic
    self.textAlign = textAlign
    self.hugText = hugText
    self.textColorHex = textColorHex
    self.dropShadowEnabled = dropShadowEnabled
    self.dropShadowColorHex = dropShadowColorHex
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
    showInLive = try container.decodeIfPresent(Bool.self, forKey: .showInLive) ?? true
    text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
    fontName = try container.decodeIfPresent(String.self, forKey: .fontName) ?? ""
    fontSize = try container.decodeIfPresent(Double.self, forKey: .fontSize) ?? 0
    isBold = try container.decodeIfPresent(Bool.self, forKey: .isBold) ?? false
    isItalic = try container.decodeIfPresent(Bool.self, forKey: .isItalic) ?? false
    textAlign = try container.decodeIfPresent(TextOverlayAlign.self, forKey: .textAlign) ?? .center
    hugText = try container.decodeIfPresent(Bool.self, forKey: .hugText) ?? true
    textColorHex = try container.decodeIfPresent(String.self, forKey: .textColorHex) ?? "#FFFFFF"
    dropShadowEnabled = try container.decodeIfPresent(Bool.self, forKey: .dropShadowEnabled) ?? false
    dropShadowColorHex = try container.decodeIfPresent(String.self, forKey: .dropShadowColorHex)
      ?? "#000000"
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

  /// Keep the top-left and current display scale; size follows the new bitmap's aspect.
  public static func replacedImageRect(
    origin: CGPoint,
    currentSize: CGSize,
    oldNative: CGSize,
    newNative: CGSize,
    canvas: CGSize
  ) -> CGRect {
    _ = canvas
    let newWidthNative = max(newNative.width, 1)
    let newHeightNative = max(newNative.height, 1)
    let size: CGSize
    if oldNative.width > 0 {
      let scale = currentSize.width / oldNative.width
      size = CGSize(width: newWidthNative * scale, height: newHeightNative * scale)
    } else {
      let width = max(currentSize.width, 1)
      size = CGSize(width: width, height: width * (newHeightNative / newWidthNative))
    }
    return CGRect(origin: origin, size: size)
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

  /// Two aspect ratios close enough that stretching a bitmap of one into a rectangle of the
  /// other is invisible.
  public static func aspectsAgree(_ a: Double, _ b: Double, tolerance: Double = 0.08) -> Bool {
    guard a > 0, b > 0 else { return false }
    return abs(a - b) / max(a, b) <= tolerance
  }

  /// Scale that leaves a web overlay the same size on screen after the page reports a different
  /// natural size for the same graphic.
  public static func scalePreservingDisplay(
    scale: Double,
    from saved: CGSize,
    to native: CGSize
  ) -> Double {
    guard saved.width >= 1, native.width >= 1 else { return scale }
    return scale * Double(saved.width / native.width)
  }

  /// A page size that disagrees with the saved one, waiting to prove it is not a transient.
  public struct PendingWebNative: Equatable, Sendable {
    public var size: CGSize
    public var firstSeen: Date

    public init(size: CGSize, firstSeen: Date) {
      self.size = size
      self.firstSeen = firstSeen
    }
  }

  /// How a new page measure should affect a web overlay that already has a saved native size.
  public struct WebNativeResolution: Equatable, Sendable {
    public var native: CGSize
    public var pending: PendingWebNative?
    public var applyLayout: Bool

    public init(native: CGSize, pending: PendingWebNative?, applyLayout: Bool) {
      self.native = native
      self.pending = pending
      self.applyLayout = applyLayout
    }
  }

  /// How long a changed page size must hold before it is believed.
  public static let webNativeSettleSeconds: TimeInterval = 2

  /// Resize only to a page size that has held steady, in either direction.
  ///
  /// The measures right after a load are wrong both ways: wrappers that have not shrink-wrapped
  /// report the whole viewport, and text measured before its web font arrives reports too narrow.
  /// Both settle within a few hundred milliseconds, whereas a page that really did change size
  /// keeps reporting the new one, so elapsed time separates them where a sample count cannot —
  /// `MutationObserver` fires twice within 120ms of a load.
  ///
  /// Applying this rule to shrinking as well as growth is what lets a saved size that is already
  /// wrong recover on its own: the true size disagrees, holds, and replaces it.
  public static func resolveWebNative(
    incoming: CGSize,
    saved: CGSize,
    pending: PendingWebNative?,
    now: Date
  ) -> WebNativeResolution {
    if saved.width < 1 || saved.height < 1 {
      return WebNativeResolution(native: incoming, pending: nil, applyLayout: true)
    }
    if nativesAgree(saved, incoming) {
      return WebNativeResolution(native: incoming, pending: nil, applyLayout: true)
    }
    // An exact 2× or 3× is the snapshot bitmap reported in pixels, never a real page change.
    if isDisplayScaleArtifact(saved: saved, incoming: incoming) {
      return WebNativeResolution(native: saved, pending: nil, applyLayout: true)
    }
    guard let pending, nativesAgree(pending.size, incoming) else {
      return WebNativeResolution(
        native: saved,
        pending: PendingWebNative(size: incoming, firstSeen: now),
        applyLayout: false
      )
    }
    guard now.timeIntervalSince(pending.firstSeen) >= webNativeSettleSeconds else {
      return WebNativeResolution(native: saved, pending: pending, applyLayout: false)
    }
    return WebNativeResolution(native: incoming, pending: nil, applyLayout: true)
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
        showInLive: overlay.showInLive,
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

  /// Hug-mode box for a text overlay. Width/height follow `textSize`; the alignment edge stays put.
  public static func huggedTextRect(
    align: TextOverlayAlign,
    current: CGRect,
    textSize: CGSize,
    canvas: CGSize
  ) -> CGRect {
    let width = min(max(textSize.width, 8), canvas.width)
    let height = min(max(textSize.height, 8), canvas.height)
    var x: CGFloat
    switch align {
    case .left:
      x = current.minX
    case .center:
      x = current.midX - width / 2
    case .right:
      x = current.maxX - width
    }
    var y = current.minY
    x = min(max(x, 0), max(canvas.width - width, 0))
    y = min(max(y, 0), max(canvas.height - height, 0))
    return CGRect(x: x, y: y, width: width, height: height)
  }

  /// Free-form resize (text locked boxes). Width and height both follow the dragged corner.
  public static func resizedFree(
    _ rect: CGRect,
    corner: Corner,
    translation: CGSize,
    canvas: CGSize,
    minimum: CGFloat = 40
  ) -> CGRect {
    var minX = rect.minX
    var minY = rect.minY
    var maxX = rect.maxX
    var maxY = rect.maxY
    switch corner {
    case .topLeft:
      minX += translation.width
      minY += translation.height
    case .topRight:
      maxX += translation.width
      minY += translation.height
    case .bottomLeft:
      minX += translation.width
      maxY += translation.height
    case .bottomRight:
      maxX += translation.width
      maxY += translation.height
    }
    var width = max(maxX - minX, minimum)
    var height = max(maxY - minY, minimum)
    if minX + width > canvas.width { width = canvas.width - minX }
    if minY + height > canvas.height { height = canvas.height - minY }
    minX = min(max(minX, 0), max(canvas.width - width, 0))
    minY = min(max(minY, 0), max(canvas.height - height, 0))
    width = min(width, canvas.width)
    height = min(height, canvas.height)
    return CGRect(x: minX, y: minY, width: width, height: height)
  }

  /// Top-left square of a content-sized web snapshot, side min(width, height).
  public static func webThumbnailCrop(contentSize: CGSize) -> CGRect {
    let side = min(contentSize.width, contentSize.height)
    guard side >= 1 else { return .zero }
    return CGRect(x: 0, y: 0, width: side, height: side)
  }
}
