/// A rectangle in points.
public struct SplashBox: Sendable, Equatable {
  public var x, y, width, height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

/// Where everything sits in a `width`×`height` window, in points.
public struct SplashGeometry: Sendable, Equatable {
  public let width: Double
  public let height: Double
  /// The mark's side: 210 on the 390×844 design, scaled to fit any window.
  public let side: Double
  /// The brand block's scale, `side / 210`; every other length scales by it.
  public let k: Double
  /// The stadium element: the window plus the bleed on every side.
  public let element: SplashBox
  /// The stadium image at scale 1, cover-fit to the element at the focus.
  public let cover: SplashBox

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
    side = min(
      SplashTimeline.designSide * width / SplashTimeline.designWidth,
      SplashTimeline.designSide * height / SplashTimeline.designHeight
    )
    k = side / SplashTimeline.designSide
    let pad = SplashTimeline.bleed * k
    element = SplashBox(x: -pad, y: -pad, width: width + 2 * pad, height: height + 2 * pad)
    let scale = max(element.width / SplashTimeline.stadiumWidth, element.height / SplashTimeline.stadiumHeight)
    let w = SplashTimeline.stadiumWidth * scale
    let h = SplashTimeline.stadiumHeight * scale
    cover = SplashBox(
      x: element.x + (element.width - w) * SplashTimeline.focusX,
      y: element.y + (element.height - h) * SplashTimeline.focusY,
      width: w,
      height: h
    )
  }

  /// The fraction of the image's width and height the window shows at scale 1.
  public var visible: (width: Double, height: Double) {
    (min(1, width / cover.width), min(1, height / cover.height))
  }

  /// The mark's centre.
  public var markCenter: (x: Double, y: Double) {
    (width * SplashTimeline.markCenterX, height * SplashTimeline.markCenterY)
  }

  /// `rect` (mark-side units from the mark's centre) in points from the mark's centre.
  public func brand(_ rect: SplashRect) -> SplashBox {
    SplashBox(x: rect.x * side, y: rect.y * side, width: rect.width * side, height: rect.height * side)
  }

  /// The part of a `imageWidth`×`imageHeight` image the stadium element shows
  /// at t = 0. The zoom keeps the focus fixed, so on each axis the view runs
  /// from f − f/s to f + (1 − f)/s of the image.
  public static func frameZeroCrop(
    imageWidth: Double = SplashTimeline.stadiumWidth,
    imageHeight: Double = SplashTimeline.stadiumHeight
  ) -> SplashBox {
    let s = SplashTimeline.stadiumTracks["scale"].keys[0].1
    func span(_ f: Double, _ size: Double) -> (Double, Double) {
      (((f - f / s) * size).rounded(), ((f + (1 - f) / s) * size).rounded())
    }
    let (x0, x1) = span(SplashTimeline.focusX, imageWidth)
    let (y0, y1) = span(SplashTimeline.focusY, imageHeight)
    return SplashBox(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
  }
}
